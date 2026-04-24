import json
import os
import re
import subprocess
import tempfile

import anthropic
from groq import Groq

# TERRAFORM_TOOL is still used by generate_terraform_with_anthropic to force
# structured output (tool_choice) from the Anthropic API. It is NOT the old
# Tool Use API agentic loop — that pattern has been removed.
TERRAFORM_TOOL = {
    "name": "generate_terraform",
    "description": "Generate complete, valid Terraform HCL for an AWS resource.",
    "input_schema": {
        "type": "object",
        "properties": {
            "hcl": {
                "type": "string",
                "description": "Complete Terraform HCL code including terraform{}, provider{}, and resource blocks.",
            },
            "resource_type": {
                "type": "string",
                "description": "Primary AWS resource type created (e.g. aws_instance, aws_s3_bucket).",
            },
            "description": {
                "type": "string",
                "description": "One-sentence plain-English description of what the config creates.",
            },
        },
        "required": ["hcl", "resource_type", "description"],
    },
}


SYSTEM_PROMPT = """\
You are a Terraform expert that generates clean, valid AWS HCL configurations.

Rules:
- Always include a terraform {} block specifying required_providers hashicorp/aws ~> 5.0
- Always include a provider "aws" {} block with a region variable (default = "us-east-1")
- Use a variable "name_prefix" (default = "demo") to avoid resource name conflicts
- Use descriptive, lowercase resource labels (e.g. "main", "this")
- Do NOT include backend configuration
- Do NOT hardcode AWS credentials or account IDs
- Keep the config minimal but complete and immediately usable\
"""


def validate_terraform_syntax(hcl: str) -> dict:
    """
    Write HCL to a temporary directory and run:
      terraform init -backend=false
      terraform validate

    Returns {"valid": bool, "message": str}.
    The temp directory is automatically deleted afterwards.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        tf_path = os.path.join(tmpdir, "main.tf")
        with open(tf_path, "w") as f:
            f.write(hcl)

        # --- terraform init ---------------------------------------------------
        init = subprocess.run(
            ["terraform", "init", "-backend=false", "-no-color"],
            cwd=tmpdir,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if init.returncode != 0:
            return {
                "valid": False,
                "message": f"Init failed: {(init.stderr or init.stdout).strip()}",
            }

        # --- terraform validate -----------------------------------------------
        validate = subprocess.run(
            ["terraform", "validate", "-no-color"],
            cwd=tmpdir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if validate.returncode == 0:
            return {"valid": True, "message": "Terraform configuration is valid."}

        return {
            "valid": False,
            "message": (validate.stderr or validate.stdout).strip(),
        }


async def generate_terraform_with_anthropic(request: str, api_key: str) -> dict:
    """
    Call Anthropic with tool_choice forced to "generate_terraform".

    The model MUST return a tool_use block — plain text is not allowed.
    This gives us guaranteed structured output without post-processing heuristics.

    Returns {"hcl": str, "resource_type": str, "description": str}.
    Raises ValueError if no tool_use block is found (should never happen with tool_choice).
    """
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    client = anthropic.Anthropic(api_key=key)

    response = client.messages.create(
        model="claude-haiku-20240307",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        tools=[TERRAFORM_TOOL],
        tool_choice={"type": "tool", "name": "generate_terraform"},
        messages=[
            {"role": "user", "content": f"Generate Terraform HCL for: {request}"}
        ],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "generate_terraform":
            return block.input

    raise ValueError(
        "Anthropic response contained no generate_terraform tool_use block."
    )


async def generate_terraform_with_groq(request: str, api_key: str) -> dict:
    """
    Call Groq with response_format=json_object and an explicit JSON schema
    in the prompt to replicate structured output without native tool_choice.

    Returns {"hcl": str, "resource_type": str, "description": str}.
    Raises json.JSONDecodeError if the model returns malformed JSON (rare with json_object mode).
    """
    key = api_key or os.getenv("GROQ_API_KEY", "")
    client = Groq(api_key=key)

    # We ask for the HCL in a fenced block and the metadata as JSON separately.
    # This avoids the json_object mode failure caused by heavily-escaped HCL strings.
    prompt = f"""{SYSTEM_PROMPT}

Generate Terraform HCL for: {request}

Reply in this exact format — no other text:

```hcl
<complete terraform HCL here>
```

```json
{{
  "resource_type": "<primary AWS resource type, e.g. aws_instance>",
  "description": "<one-sentence plain-English description>"
}}
```"""

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=2048,
        temperature=0.1,
    )

    raw = response.choices[0].message.content

    hcl_match = re.search(r"```hcl\s*(.*?)```", raw, re.DOTALL)
    hcl = hcl_match.group(1).strip() if hcl_match else ""

    json_match = re.search(r"```json\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if json_match:
        meta = json.loads(json_match.group(1))
    else:
        meta = {"resource_type": "unknown", "description": ""}

    return {
        "hcl": hcl,
        "resource_type": meta.get("resource_type", "unknown"),
        "description": meta.get("description", ""),
    }


async def generate_terraform(request: str, model: str, api_key: str) -> dict:
    """
    Route to the correct provider, then validate the generated HCL.

    Returns:
      {
        "hcl":           str,   # The generated Terraform code
        "resource_type": str,   # e.g. "aws_instance"
        "description":   str,   # Plain-English description
        "validation":    {      # Result of terraform init + validate
          "valid":   bool,
          "message": str,
        },
        "error": str | None,    # Only present if generation itself failed
      }

    Never raises — all errors are captured and returned as structured JSON
    so the endpoint always returns HTTP 200.
    """
    try:
        if model == "anthropic":
            result = await generate_terraform_with_anthropic(request, api_key)
        else:
            result = await generate_terraform_with_groq(request, api_key)

        validation = validate_terraform_syntax(result["hcl"])
        result["validation"] = validation
        result["error"] = None
        return result

    except Exception as e:
        return {
            "hcl": "",
            "resource_type": "unknown",
            "description": "Generation failed.",
            "validation": {"valid": False, "message": str(e)},
            "error": str(e),
        }


def handle_generate_terraform(
    hcl: str,
    resource_type: str = "unknown",
    description: str = "",
) -> dict:
    """
    Passthrough handler for the generate_terraform tool.

    The LLM has already produced the structured output (hcl, resource_type,
    description) inside its tool_use block. This handler simply surfaces those
    values as a plain dict so dispatch_tool has a uniform return path.

    Returns {"hcl": str, "resource_type": str, "description": str}
    """
    return {
        "hcl": hcl,
        "resource_type": resource_type,
        "description": description,
    }


def handle_run_terraform_plan(
    hcl_content: str,
    resource_description: str = "",
) -> dict:
    """
    Write HCL to a persistent temp directory, then run:
      terraform init -backend=false -no-color
      terraform plan  -no-color

    Uses tempfile.mkdtemp() (not TemporaryDirectory) so the working directory
    survives after the function returns — the caller may need its path, e.g.
    to run terraform apply later with the saved plan binary.

    Returns:
      {
        "success":      bool,   # True only if both init AND plan exit 0
        "plan_output":  str,    # Combined stdout from plan (or init error)
        "return_code":  int,    # Exit code of the last subprocess run
        "working_dir":  str,    # Absolute path to the temp dir with main.tf
      }

    Never raises — all subprocess errors are captured and returned as
    structured output so the agentic loop can handle them gracefully.
    """
    working_dir = tempfile.mkdtemp(prefix="aca_plan_")

    try:
        tf_path = os.path.join(working_dir, "main.tf")
        with open(tf_path, "w") as f:
            f.write(hcl_content)

        init = subprocess.run(
            ["terraform", "init", "-backend=false", "-no-color"],
            cwd=working_dir,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if init.returncode != 0:
            return {
                "success": False,
                "plan_output": f"terraform init failed:\n{(init.stderr or init.stdout).strip()}",
                "return_code": init.returncode,
                "working_dir": working_dir,
            }

        plan = subprocess.run(
            ["terraform", "plan", "-no-color"],
            cwd=working_dir,
            capture_output=True,
            text=True,
            timeout=180,
        )

        plan_output = (plan.stdout or "").strip()
        if plan.stderr:
            plan_output = (
                plan_output + "\n" + plan.stderr.strip()
                if plan_output
                else plan.stderr.strip()
            )

        return {
            "success": plan.returncode == 0,
            "plan_output": plan_output,
            "return_code": plan.returncode,
            "working_dir": working_dir,
        }

    except subprocess.TimeoutExpired as e:
        return {
            "success": False,
            "plan_output": f"Terraform command timed out: {str(e)}",
            "return_code": -1,
            "working_dir": working_dir,
        }
    except Exception as e:
        return {
            "success": False,
            "plan_output": f"Unexpected error during plan: {str(e)}",
            "return_code": -1,
            "working_dir": working_dir,
        }


def handle_summarise_plan(
    plan_output: str,
    issue_being_fixed: str,
    risk_level: str = "medium",
) -> dict:
    """
    Parse raw terraform plan output and produce a plain-English summary
    suitable for a non-expert to read before clicking "Approve".

    Parsing logic:
      - Looks for "Plan: X to add, Y to change, Z to destroy."
      - Falls back to "No changes." detection
      - counts_total = adds + changes + destroys

    safe_to_approve heuristic:
      - False immediately if destroys > 0  (destructive changes need scrutiny)
      - False if risk_level == "high"
      - True  otherwise (adds/changes at low/medium risk)

    Returns:
      {
        "summary":         str,   # Human-readable description of the plan
        "changes_count":   int,   # Total number of resource actions
        "risk_level":      str,   # Echoed back (may be overridden to "high" if destroys > 0)
        "safe_to_approve": bool,
      }
    """

    adds = 0
    changes = 0
    destroys = 0

    plan_match = re.search(
        r"Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy",
        plan_output,
        re.IGNORECASE,
    )

    no_changes = bool(
        re.search(
            r"No changes\.|Your infrastructure matches the configuration",
            plan_output,
            re.IGNORECASE,
        )
    )

    if plan_match:
        adds = int(plan_match.group(1))
        changes = int(plan_match.group(2))
        destroys = int(plan_match.group(3))
    elif not no_changes:
        return {
            "summary": (
                f"Could not parse terraform plan output.\n\n"
                f"Issue being addressed: {issue_being_fixed}\n\n"
                f"Raw output (first 500 chars):\n{plan_output[:500]}"
            ),
            "changes_count": 0,
            "risk_level": risk_level,
            "safe_to_approve": False,
        }

    changes_count = adds + changes + destroys

    if destroys > 0:
        risk_level = "high"

    safe_to_approve = (destroys == 0) and (risk_level != "high")

    if no_changes:
        action_line = "No changes will be made to your infrastructure."
    else:
        parts = []
        if adds:
            parts.append(f"{adds} resource{'s' if adds != 1 else ''} will be created")
        if changes:
            parts.append(
                f"{changes} resource{'s' if changes != 1 else ''} will be modified"
            )
        if destroys:
            parts.append(
                f"{destroys} resource{'s' if destroys != 1 else ''} will be DESTROYED"
            )
        action_line = "; ".join(parts) + "."

    risk_emoji = {"low": "🟢", "medium": "🟡", "high": "🔴"}.get(risk_level, "⚪")
    approve_text = (
        "This plan appears safe to apply."
        if safe_to_approve
        else "Review carefully before approving — this plan carries elevated risk."
    )

    summary = (
        f"Issue being fixed: {issue_being_fixed}\n\n"
        f"What will happen: {action_line}\n"
        f"  • Resources to create:  {adds}\n"
        f"  • Resources to modify:  {changes}\n"
        f"  • Resources to destroy: {destroys}\n\n"
        f"Risk level: {risk_emoji} {risk_level.upper()}\n\n"
        f"{approve_text}"
    )

    return {
        "summary": summary,
        "changes_count": changes_count,
        "risk_level": risk_level,
        "safe_to_approve": safe_to_approve,
    }


