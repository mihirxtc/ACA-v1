import json
import os
import re
import shutil
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock

_BACKEND_DIR = Path(__file__).parent.parent
WORKDIR_BASE = _BACKEND_DIR / "terraform_workdirs"
EXECUTION_LOG = _BACKEND_DIR / "execution_log.json"
_TF_PLUGIN_CACHE = _BACKEND_DIR / ".terraform_plugin_cache"

# File-level lock that serialises all read-modify-write operations on the log.
# Two concurrent plan requests arriving at the same millisecond would otherwise
# both read the same state, each append their entry, and the second write would
# silently overwrite the first — losing the earlier execution record.
_LOG_LOCK = FileLock(str(EXECUTION_LOG) + ".lock", timeout=10)


def _build_env(aws_creds: dict | None) -> dict:
    """Return an os.environ copy with AWS credentials injected if provided."""
    env = os.environ.copy()
    # Persist downloaded providers across executions so terraform init never
    # re-downloads on the second run (first run may be slow, but subsequent
    # ones hit the cache and complete in seconds).
    _TF_PLUGIN_CACHE.mkdir(parents=True, exist_ok=True)
    env["TF_PLUGIN_CACHE_DIR"] = str(_TF_PLUGIN_CACHE)
    if aws_creds:
        if aws_creds.get("aws_access_key_id"):
            env["AWS_ACCESS_KEY_ID"] = aws_creds["aws_access_key_id"]
        if aws_creds.get("aws_secret_access_key"):
            env["AWS_SECRET_ACCESS_KEY"] = aws_creds["aws_secret_access_key"]
        if aws_creds.get("aws_region"):
            env["AWS_DEFAULT_REGION"] = aws_creds["aws_region"]
    return env


def create_execution_id() -> str:
    """
    Generate a unique execution ID combining a human-readable timestamp
    and a short UUID fragment.

    Format: exec_YYYYMMDD_HHMMSS_xxxxxxxx
    Example: exec_20260322_143022_a1b2c3d4

    The timestamp makes logs easy to read chronologically.
    The UUID fragment prevents collisions if two plans start within the
    same second (unlikely in a single-user demo, but safe regardless).
    """
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    short_id = str(uuid.uuid4())[:8]
    return f"exec_{timestamp}_{short_id}"


def get_working_dir(execution_id: str) -> Path:
    """
    Return (and create if needed) the persistent working directory for
    a given execution.

    Each execution gets its own subdirectory:
      terraform_workdirs/exec_20260322_143022_a1b2c3d4/

    This directory holds:
      main.tf   — the generated HCL written before terraform init
      tfplan    — the binary plan file saved by terraform plan -out=tfplan
      .terraform/  — provider plugins downloaded by terraform init

    mkdir(parents=True, exist_ok=True) creates the full path including
    WORKDIR_BASE itself if it does not yet exist.
    """
    workdir = WORKDIR_BASE / execution_id
    workdir.mkdir(parents=True, exist_ok=True)
    return workdir


def run_terraform_plan(hcl_config: str, execution_id: str, aws_creds: dict | None = None) -> dict:
    """
    Write HCL to a PERSISTENT working directory, then run:
      terraform init -backend=false
      terraform plan -out=tfplan -no-color

    The tfplan binary file is saved in the working directory and used
    later by run_terraform_apply(). This function is READ-ONLY — it
    never modifies AWS resources.

    Arguments:
      hcl_config   — complete Terraform HCL as a string
      execution_id — unique ID for this execution (from create_execution_id)

    Returns a dict:
      {
        "success":              bool,   True if plan succeeded
        "plan_output":          str,    Combined stdout + stderr
        "resources_to_add":     int,    Parsed from plan summary line
        "resources_to_change":  int,
        "resources_to_destroy": int,
      }

    On failure (init error, plan error, timeout, unexpected exception):
      success is False and plan_output contains the error message.
    """
    try:
        workdir = get_working_dir(execution_id)
        env = _build_env(aws_creds)

        tf_path = workdir / "main.tf"
        tf_path.write_text(hcl_config, encoding="utf-8")

        init_result = subprocess.run(
            ["terraform", "init", "-backend=false", "-no-color"],
            capture_output=True,
            text=True,
            cwd=workdir,
            timeout=180,
            env=env,
        )

        if init_result.returncode != 0:
            init_output = init_result.stdout + init_result.stderr
            return {
                "success": False,
                "plan_output": f"terraform init failed:\n{init_output.strip()}",
                "resources_to_add": 0,
                "resources_to_change": 0,
                "resources_to_destroy": 0,
            }

        plan_result = subprocess.run(
            ["terraform", "plan", "-out=tfplan", "-no-color"],
            capture_output=True,
            text=True,
            cwd=workdir,
            timeout=120,
            env=env,
        )

        plan_output = plan_result.stdout + plan_result.stderr

        return {
            "success": plan_result.returncode == 0,
            "plan_output": plan_output,
            "resources_to_add": _parse_count(plan_output, "add"),
            "resources_to_change": _parse_count(plan_output, "change"),
            "resources_to_destroy": _parse_count(plan_output, "destroy"),
        }

    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "plan_output": "terraform plan timed out after 120 seconds.",
            "resources_to_add": 0,
            "resources_to_change": 0,
            "resources_to_destroy": 0,
        }
    except Exception as e:
        return {
            "success": False,
            "plan_output": f"Unexpected error during plan: {str(e)}",
            "resources_to_add": 0,
            "resources_to_change": 0,
            "resources_to_destroy": 0,
        }


def run_terraform_apply(execution_id: str, aws_creds: dict | None = None) -> dict:
    """
    Apply the previously planned Terraform changes using the saved tfplan file.

    WHY WE USE THE SAVED tfplan FILE:
      The binary tfplan file was saved during run_terraform_plan() with
      terraform plan -out=tfplan. Using it here guarantees that what
      gets applied is exactly what the user reviewed and approved —
      not a new plan computed at apply time (which might differ if AWS
      state changed in the interim).

    WHY -auto-approve IS SAFE HERE:
      Normally, terraform apply prompts the user to type "yes" to confirm.
      -auto-approve skips that prompt. This is safe here because:
        (1) The user already approved explicitly via the UI approval gate.
        (2) We are applying the exact saved tfplan file, not a new plan.
      We would NOT use -auto-approve if we were re-computing the plan at
      apply time — that would be dangerous.

    ONLY call this function after receiving approved=True from the user.
    The check for approved=True is enforced in the API endpoint, not here.

    Arguments:
      execution_id — must match the ID used in run_terraform_plan()

    Returns a dict:
      {
        "success":          bool,
        "apply_output":     str,
        "resources_applied": list[str],  e.g. ["aws_s3_bucket.main"]
      }
    """
    try:
        workdir = get_working_dir(execution_id)
        tfplan = workdir / "tfplan"
        env = _build_env(aws_creds)

        if not tfplan.exists():
            return {
                "success": False,
                "apply_output": (
                    f"No plan file found for execution '{execution_id}'. "
                    f"Run terraform plan first."
                ),
                "resources_applied": [],
            }

        apply_result = subprocess.run(
            ["terraform", "apply", "-auto-approve", "-no-color", "tfplan"],
            capture_output=True,
            text=True,
            cwd=workdir,
            timeout=300,
            env=env,
        )

        apply_output = apply_result.stdout + apply_result.stderr
        success = apply_result.returncode == 0

        # Collect metadata for any .pem key files written by local_file resources.
        # We return only the filename — NOT the key content — so that private key
        # material is never embedded in an HTTP response body. Callers that need
        # the key should call get_key_file(execution_id, filename) directly or
        # use the GET /terraform/keys/{execution_id}/{filename} download endpoint.
        key_files = []
        if success:
            for entry in workdir.iterdir():
                if entry.suffix == ".pem" and entry.is_file():
                    key_files.append({"name": entry.name})

            # Remove the provider-plugin cache (.terraform/) and the consumed
            # plan binary (tfplan) — together ~200MB per execution.
            # main.tf and any .pem key files are kept: main.tf for audit
            # trail, .pem files because the user may still need to download
            # them via GET /terraform/keys/{execution_id}/{filename}.
            plugin_dir = workdir / ".terraform"
            if plugin_dir.exists():
                shutil.rmtree(plugin_dir, ignore_errors=True)
            tfplan_file = workdir / "tfplan"
            if tfplan_file.exists():
                tfplan_file.unlink(missing_ok=True)

        return {
            "success": success,
            "apply_output": apply_output,
            "resources_applied": _parse_applied(apply_output),
            "key_files": key_files,
        }

    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "apply_output": "terraform apply timed out after 300 seconds.",
            "resources_applied": [],
        }
    except Exception as e:
        return {
            "success": False,
            "apply_output": f"Unexpected error during apply: {str(e)}",
            "resources_applied": [],
        }


def run_terraform_destroy(execution_id: str, aws_creds: dict | None = None) -> dict:
    """
    Destroy resources created by a previous apply using the saved main.tf.

    After apply, .terraform/ and tfplan are cleaned up but main.tf is kept.
    This function re-runs terraform init then terraform destroy -auto-approve
    so the user can roll back a completed execution from the UI.

    Returns {"success": bool, "destroy_output": str}.
    """
    try:
        workdir = get_working_dir(execution_id)
        tf_path = workdir / "main.tf"
        env = _build_env(aws_creds)

        if not tf_path.exists():
            return {
                "success": False,
                "destroy_output": f"No main.tf found for execution '{execution_id}'. Cannot destroy.",
            }

        init_result = subprocess.run(
            ["terraform", "init", "-backend=false", "-no-color"],
            capture_output=True, text=True, cwd=workdir, timeout=60, env=env,
        )
        if init_result.returncode != 0:
            return {
                "success": False,
                "destroy_output": f"terraform init failed:\n{(init_result.stdout + init_result.stderr).strip()}",
            }

        destroy_result = subprocess.run(
            ["terraform", "destroy", "-auto-approve", "-no-color"],
            capture_output=True, text=True, cwd=workdir, timeout=300, env=env,
        )
        output  = destroy_result.stdout + destroy_result.stderr
        success = destroy_result.returncode == 0

        if success:
            plugin_dir = workdir / ".terraform"
            if plugin_dir.exists():
                shutil.rmtree(plugin_dir, ignore_errors=True)

        return {"success": success, "destroy_output": output}

    except subprocess.TimeoutExpired:
        return {"success": False, "destroy_output": "terraform destroy timed out after 300 seconds."}
    except Exception as e:
        return {"success": False, "destroy_output": f"Unexpected error during destroy: {str(e)}"}


def get_key_file(execution_id: str, filename: str) -> bytes:
    """
    Read and return the raw bytes of a .pem key file for a given execution.

    Security constraints enforced here:
      - filename must not contain any path separator (prevents traversal like
        '../../etc/passwd')
      - filename must end with '.pem' (only key files served)
      - the resolved path must be a direct child of the execution workdir
        (double-checked after Path resolution to defeat symlink attacks)

    Raises FileNotFoundError if the file does not exist.
    Raises ValueError if the filename fails any security check.
    """
    if "/" in filename or "\\" in filename:
        raise ValueError(f"Invalid filename: '{filename}'")
    if not filename.endswith(".pem"):
        raise ValueError("Only .pem files can be downloaded")

    workdir = WORKDIR_BASE / execution_id
    key_path = (workdir / filename).resolve()

    # Ensure the resolved path is still inside the expected workdir
    if workdir.resolve() not in key_path.parents:
        raise ValueError("Path traversal detected")

    if not key_path.exists():
        raise FileNotFoundError(f"Key file '{filename}' not found for execution '{execution_id}'")

    return key_path.read_bytes()


def _read_log_unlocked() -> list:
    """Read the log file without acquiring the lock (internal helper)."""
    if not EXECUTION_LOG.exists():
        return []
    try:
        return json.loads(EXECUTION_LOG.read_text(encoding="utf-8"))
    except Exception:
        return []


def log_execution(entry: dict) -> None:
    """
    Append a new execution entry to the persistent execution log file.

    The log file is a JSON array stored at execution_log.json.
    Uses a file lock to prevent concurrent writes from overwriting each other.

    Arguments:
      entry — a dict matching the execution log schema.
    """
    with _LOG_LOCK:
        history = _read_log_unlocked()
        history.append(entry)
        EXECUTION_LOG.write_text(
            json.dumps(history, indent=2, default=str),
            encoding="utf-8",
        )


def log_execution_update(execution_id: str, updates: dict) -> None:
    """
    Update an existing log entry in-place by execution_id.

    Uses a file lock to prevent concurrent updates from overwriting each other.
    If no matching entry is found, this function does nothing.

    Arguments:
      execution_id — the ID of the entry to update
      updates      — dict of fields to merge into the existing entry
    """
    with _LOG_LOCK:
        history = _read_log_unlocked()
        for entry in history:
            if entry.get("execution_id") == execution_id:
                entry.update(updates)
                break
        EXECUTION_LOG.write_text(
            json.dumps(history, indent=2, default=str),
            encoding="utf-8",
        )


def get_execution_history() -> list:
    """
    Read and return all execution log entries from execution_log.json.

    Returns an empty list if the file does not exist yet (first run)
    or if the file is corrupted / unreadable.

    This function never raises — the caller can always iterate the result.
    """
    if not EXECUTION_LOG.exists():
        return []
    try:
        return json.loads(EXECUTION_LOG.read_text(encoding="utf-8"))
    except Exception:
        return []


def _parse_count(output: str, action: str) -> int:
    """
    Parse a resource change count from terraform plan output.

    Terraform plan output includes a summary line like:
      Plan: 2 to add, 0 to change, 0 to destroy.

    Arguments:
      output — full plan output string
      action — "add", "change", or "destroy"

    Returns the integer count, or 0 if the pattern is not found.
    """
    patterns = {
        "add": r"(\d+) to add",
        "change": r"(\d+) to change",
        "destroy": r"(\d+) to destroy",
    }
    match = re.search(patterns.get(action, ""), output)
    return int(match.group(1)) if match else 0


def _parse_applied(output: str) -> list:
    """
    Extract resource addresses from terraform apply output.

    Terraform apply prints lines like:
      aws_s3_bucket.main: Creation complete after 3s [id=my-bucket]

    This function finds all such lines and returns the resource addresses.

    Arguments:
      output — full apply output string

    Returns a list of resource address strings, e.g.:
      ["aws_s3_bucket.main", "aws_s3_bucket_versioning.main"]
    """
    return re.findall(r"([\w.]+): Creation complete", output)
