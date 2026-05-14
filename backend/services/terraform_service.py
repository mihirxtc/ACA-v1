import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import anthropic
import httpx
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
                "description": "Complete Terraform HCL including terraform{} with hashicorp/aws ~>5.0 AND hashicorp/random ~>3.0 providers, a random_id suffix resource, provider{}, variable{}, and all resource blocks. Every AWS resource name MUST include ${random_id.suffix.hex} to guarantee uniqueness.",
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

NAMING UNIQUENESS — CRITICAL:
Every config MUST include the hashicorp/random provider and a random_id resource so that
resource names are unique across multiple deployments of the same template:

  terraform {
    required_providers {
      aws    = { source = "hashicorp/aws",    version = "~> 5.0" }
      random = { source = "hashicorp/random", version = "~> 3.0" }
    }
  }

  resource "random_id" "suffix" { byte_length = 4 }

Append ${random_id.suffix.hex} to resource names that must be GLOBALLY UNIQUE in AWS
(security group names within a VPC, S3 bucket names, IAM entity names, DB identifiers,
key pair names). EC2 Name TAGS do not need the suffix — use the user's requested name
exactly as the Name tag value.
  tags = { Name = "mihir-server-1" }          # exact user-specified name in tag
  name = "demo-sg-${random_id.suffix.hex}"    # suffix only on names that must be unique
This prevents 400/409 "already exists" conflicts on every re-deploy.

EC2 SSH KEY PAIR — ALWAYS when creating any EC2 instance (even without SSH mention):
ALWAYS generate a TLS key pair and save the private key locally using the tls provider:

  terraform {
    required_providers {
      aws    = { source = "hashicorp/aws",    version = "~> 5.0" }
      random = { source = "hashicorp/random", version = "~> 3.0" }
      tls    = { source = "hashicorp/tls",    version = "~> 4.0" }
    }
  }

  resource "tls_private_key" "ssh" {
    algorithm = "RSA"
    rsa_bits  = 4096
  }

  resource "aws_key_pair" "this" {
    key_name   = "${var.name_prefix}-key-${random_id.suffix.hex}"
    public_key = tls_private_key.ssh.public_key_openssh
  }

  resource "local_file" "private_key" {
    content         = tls_private_key.ssh.private_key_pem
    filename        = "${path.module}/${var.name_prefix}-key.pem"
    file_permission = "0400"
  }

  # Then reference in the EC2 resource:
  resource "aws_instance" "this" {
    key_name = aws_key_pair.this.key_name
    ...
  }

Add "local" = { source = "hashicorp/local", version = "~> 2.0" } to required_providers
when using local_file.

NEW EC2 INSTANCE — when creating a fresh EC2 instance with a NEW security group:
  Include an SSH ingress rule (port 22) so the generated key pair is usable.
  Use a variable for the SSH CIDR with default "0.0.0.0/0" so the instance is reachable,
  AND always emit an output block reminding the user to lock it down:

  variable "allowed_ssh_cidr" {
    description = "CIDR allowed to SSH. Default 0.0.0.0/0 works for demos — restrict to your IP (run: curl ifconfig.me) for production."
    default     = "0.0.0.0/0"
  }

  # In the security group ingress rule:
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  # Always add this output so the user sees the security reminder in plan/apply output:
  output "ssh_security_reminder" {
    value = "SSH is open to ${var.allowed_ssh_cidr}. To restrict: set allowed_ssh_cidr=<your-ip>/32 (get your IP: curl ifconfig.me)"
  }

  203.0.113.45/32 is an RFC 5737 documentation-only IP that belongs to nobody — NEVER use it
  for new EC2 instances because it will block all real SSH connections.

MY IP / SPECIFIC IP RESTRICTION — ONLY when the user says "from my IP" or "my IP only"
AND you are adding a rule to a PRE-EXISTING security group (not a newly created one):
Use a variable with a documentation-range default so terraform plan succeeds AND the new
rule is never a duplicate of the existing 0.0.0.0/0 rule already on that security group:
  variable "allowed_ssh_cidr" {
    description = "CIDR for SSH access. REPLACE with your actual IP before applying, e.g. 203.0.113.45/32"
    default     = "203.0.113.45/32"
  }
Do NOT use default = "0.0.0.0/0" in this specific case — it duplicates the existing open
rule on the pre-existing SG and causes AWS to reject the apply with "duplicate Security
Group rule" errors. Use ${var.allowed_ssh_cidr} in the ingress rule.

Additional rules:
- Always include a provider "aws" {} block with a variable "region" (default = "us-east-1")
- Use a variable "name_prefix" (default = "demo")
- Use descriptive, lowercase resource labels (e.g. "main", "this")
- Do NOT include backend configuration
- Do NOT hardcode AWS credentials or account IDs
- Keep the config minimal but complete and immediately usable
- NEVER use data sources that query AWS at plan time (no data "aws_availability_zones",
  data "aws_vpc", data "aws_subnets", data "aws_ami", etc.) — hardcode sensible defaults instead
- For availability zones use literal strings: "${var.region}a" and "${var.region}b"
- For EC2 security groups omit vpc_id to use the default VPC
- For RDS: always create an aws_vpc + two aws_subnet resources (10.0.1.0/24 in <region>a,
  10.0.2.0/24 in <region>b) and an aws_db_subnet_group referencing them inline
- For VPC configs: hardcode CIDR blocks (10.0.0.0/16, subnets 10.0.x.0/24) and AZ literals
- For IAM: use aws_iam_policy_document data source (it is local computation, not an AWS API call)
- For S3 bucket names: AWS requires globally unique names — the random suffix is mandatory
- For EBS storage: use root_block_device { volume_size = N, volume_type = "gp3" } inside the
  aws_instance resource for the root volume. For additional volumes use aws_ebs_volume +
  aws_volume_attachment.

SECURITY GROUP RULE FIXES — CRITICAL:
- `revoke_rules` is an argument on `aws_security_group` ONLY — NEVER place it inside
  an `aws_security_group_rule` resource; it will cause "Unsupported argument" errors
- To restrict SSH/port access on an existing security group: create a NEW
  `aws_security_group_rule` resource with the restricted cidr_blocks and type = "ingress"
- Never attempt to destroy or modify individual existing rules via Terraform without
  first importing them — instead add the restrictive rule and note the open rule must
  be removed manually
- Correct pattern for SSH restriction fix:
    resource "aws_security_group_rule" "restrict_ssh" {
      type              = "ingress"
      from_port         = 22
      to_port           = 22
      protocol          = "tcp"
      cidr_blocks       = [var.allowed_ssh_cidr]   # must NOT be 0.0.0.0/0
      security_group_id = "<existing-sg-id>"
    }
- The new rule CIDR must differ from the existing open rule — using 0.0.0.0/0 would
  duplicate the existing rule and cause AWS to reject with "duplicate Security Group rule"
- Always use the RFC 5737 TEST-NET default (203.0.113.45/32) FOR SECURITY GROUP FIXES
  so plan + apply succeed; the user then replaces it with their real IP
- IMPORTANT: 203.0.113.45/32 is ONLY correct here (fixing an existing SG). For new EC2
  instances use 0.0.0.0/0 so the instance is actually reachable.

EXISTING INFRASTRUCTURE AWARENESS — CRITICAL:
When the user message contains an EXISTING_INFRA block, you MUST read it carefully and:
1. If a suitable security group already exists, reference its ID as a literal string instead
   of creating a new aws_security_group resource.
   Example: vpc_security_group_ids = ["sg-0abc123def456789a"]
2. If a VPC already exists, use its ID as a literal string for vpc_id instead of creating
   a new aws_vpc.
   Example: vpc_id = "vpc-0abc123def456789a"
3. If subnets already exist in the right AZs, use their IDs as literal strings instead of
   creating new aws_subnet resources.
   Example: subnet_ids = ["subnet-0abc123", "subnet-0def456"]
4. If an IAM role already exists for the needed purpose, reference it by ARN or name.
5. NEVER create an S3 bucket with the same name as one listed in EXISTING_INFRA.
6. Only create new resources when nothing suitable already exists.\
"""


_TF_PLUGIN_CACHE = Path(__file__).parent.parent / ".terraform_plugin_cache"


def validate_terraform_syntax(hcl: str) -> dict:
    """
    Write HCL to a temporary directory and run:
      terraform init -backend=false
      terraform validate

    Returns {"valid": bool, "message": str}.
    The temp directory is automatically deleted afterwards.
    """
    _TF_PLUGIN_CACHE.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["TF_PLUGIN_CACHE_DIR"] = str(_TF_PLUGIN_CACHE)

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
            timeout=180,
            env=env,
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
            env=env,
        )
        if validate.returncode == 0:
            return {"valid": True, "message": "Terraform configuration is valid."}

        return {
            "valid": False,
            "message": (validate.stderr or validate.stdout).strip(),
        }


async def generate_terraform_with_anthropic(request: str, api_key: str, existing_infra: str = "") -> dict:
    """
    Call Anthropic with tool_choice forced to "generate_terraform".

    The model MUST return a tool_use block — plain text is not allowed.
    This gives us guaranteed structured output without post-processing heuristics.

    Returns {"hcl": str, "resource_type": str, "description": str}.
    Raises ValueError if no tool_use block is found (should never happen with tool_choice).
    """
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    client = anthropic.Anthropic(api_key=key)

    user_content = f"Generate Terraform HCL for: {request}"
    if existing_infra:
        user_content += f"\n\nEXISTING_INFRA:\n{existing_infra}"

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        # model="claude-haiku-20240307",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        tools=[TERRAFORM_TOOL],
        tool_choice={"type": "tool", "name": "generate_terraform"},
        messages=[
            {"role": "user", "content": user_content}
        ],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "generate_terraform":
            return block.input

    raise ValueError(
        "Anthropic response contained no generate_terraform tool_use block."
    )


async def generate_terraform_with_groq(request: str, api_key: str, existing_infra: str = "") -> dict:
    """
    Call Groq with response_format=json_object and an explicit JSON schema
    in the prompt to replicate structured output without native tool_choice.

    Returns {"hcl": str, "resource_type": str, "description": str}.
    Raises json.JSONDecodeError if the model returns malformed JSON (rare with json_object mode).
    """
    key = api_key or os.getenv("GROQ_API_KEY", "")
    client = Groq(api_key=key)

    infra_section = f"\n\nEXISTING_INFRA:\n{existing_infra}" if existing_infra else ""

    # We ask for the HCL in a fenced block and the metadata as JSON separately.
    # This avoids the json_object mode failure caused by heavily-escaped HCL strings.
    prompt = f"""{SYSTEM_PROMPT}

Generate Terraform HCL for: {request}{infra_section}

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


async def generate_terraform_with_ollama(request: str, api_key: str, existing_infra: str = "", model_name: str = "gpt-oss:120b-cloud") -> dict:
    """
    Call a locally running Ollama instance to generate Terraform HCL.

    Uses the /api/chat endpoint with the same structured prompt as Groq.
    api_key holds the Ollama base URL (e.g. http://localhost:11434).
    Falls back to localhost if api_key is empty.
    """
    base_url = (api_key or "http://localhost:11434").rstrip("/")

    infra_section = f"\n\nEXISTING_INFRA:\n{existing_infra}" if existing_infra else ""

    prompt = f"""{SYSTEM_PROMPT}

Generate Terraform HCL for: {request}{infra_section}

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

    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            f"{base_url}/api/chat",
            json={
                "model": model_name,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            },
        )
        if response.status_code == 403 or "subscription" in response.text.lower():
            raise ValueError(
                f"'{model_name}' requires an Ollama subscription. "
                "Run `ollama signin` or pick a free local model."
            )
        response.raise_for_status()
        raw = response.json()["message"]["content"]

    hcl_match = re.search(r"```hcl\s*(.*?)```", raw, re.DOTALL)
    hcl = hcl_match.group(1).strip() if hcl_match else ""

    json_match = re.search(r"```json\s*(\{.*?\})\s*```", raw, re.DOTALL)
    meta = json.loads(json_match.group(1)) if json_match else {}

    return {
        "hcl": hcl,
        "resource_type": meta.get("resource_type", "unknown"),
        "description": meta.get("description", ""),
    }


async def generate_terraform(request: str, model: str, api_key: str, existing_infra: str = "", model_name: str = "gpt-oss:120b-cloud") -> dict:
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
    Retries up to 3 times when the model returns empty HCL (common with Ollama
    when the model fails to emit a fenced ```hcl block).
    """
    max_attempts = 3 if model == "ollama" else 2
    last_result: dict = {}

    for attempt in range(max_attempts):
        try:
            if model == "anthropic":
                result = await generate_terraform_with_anthropic(request, api_key, existing_infra)
            elif model == "ollama":
                result = await generate_terraform_with_ollama(request, api_key, existing_infra, model_name)
            else:
                result = await generate_terraform_with_groq(request, api_key, existing_infra)

            if result.get("hcl"):
                validation = validate_terraform_syntax(result["hcl"])
                result["validation"] = validation
                result["error"] = None
                return result

            last_result = {
                "hcl": "",
                "resource_type": result.get("resource_type", "unknown"),
                "description": result.get("description", "Empty HCL returned."),
                "validation": {"valid": False, "message": "Model returned empty HCL."},
                "error": "Model returned empty HCL.",
            }

        except Exception as e:
            last_result = {
                "hcl": "",
                "resource_type": "unknown",
                "description": "Generation failed.",
                "validation": {"valid": False, "message": str(e)},
                "error": str(e),
            }

    return last_result


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


