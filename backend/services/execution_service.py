import json
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

WORKDIR_BASE = Path("terraform_workdirs")
EXECUTION_LOG = Path("execution_log.json")


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


def run_terraform_plan(hcl_config: str, execution_id: str) -> dict:
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

        tf_path = workdir / "main.tf"
        tf_path.write_text(hcl_config, encoding="utf-8")

        init_result = subprocess.run(
            ["terraform", "init", "-backend=false", "-no-color"],
            capture_output=True,
            text=True,
            cwd=workdir,
            timeout=60,
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


def run_terraform_apply(execution_id: str) -> dict:
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
        )

        apply_output = apply_result.stdout + apply_result.stderr

        return {
            "success": apply_result.returncode == 0,
            "apply_output": apply_output,
            "resources_applied": _parse_applied(apply_output),
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


def log_execution(entry: dict) -> None:
    """
    Append a new execution entry to the persistent execution log file.

    The log file is a JSON array stored at execution_log.json.
    It grows indefinitely — acceptable for a dissertation demo.
    In production you would rotate or archive log entries.

    Arguments:
      entry — a dict matching the execution log schema (11 fields).
    """
    history = get_execution_history()
    history.append(entry)
    EXECUTION_LOG.write_text(
        json.dumps(history, indent=2, default=str),
        encoding="utf-8",
    )


def log_execution_update(execution_id: str, updates: dict) -> None:
    """
    Update an existing log entry in-place by execution_id.

    Used to add the approval decision and apply result to an entry
    that was created during the plan step.

    If no matching entry is found, this function does nothing —
    it never raises an exception.

    Arguments:
      execution_id — the ID of the entry to update
      updates      — dict of fields to merge into the existing entry
    """
    history = get_execution_history()
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
    return re.findall(r"(\w+\.\w+): Creation complete", output)
