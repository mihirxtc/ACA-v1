import asyncio
import json
import os
from datetime import datetime, timezone

import anthropic
from fastmcp import Client
from mcp_server import mcp

from services.aws_scanner import (
    scan_ec2,
    scan_iam,
    scan_s3,
    scan_security_groups,
    scan_vpc,
)
from services.execution_service import (
    create_execution_id,
    log_execution,
    log_execution_update,
    run_terraform_apply,
    run_terraform_plan,
)
from services.security_analyzer import run_security_analysis

# =============================================================================
# System prompt for the agentic loop
# =============================================================================

SYSTEM_PROMPT = """You are a cloud security remediation agent for AWS infrastructure.

You will receive AWS infrastructure scan results containing security findings.

Your task:
1. Identify the single highest-priority security issue from the findings
2. Use generate_terraform_from_request to create a Terraform fix for that issue
3. Use run_terraform_plan_mcp to validate and plan the change
4. Use summarise_plan_for_human to produce a clear approval summary

Rules:
- Fix ONE issue per run — do not attempt to fix multiple issues at once
- Always plan before summarising — never summarise without a plan
- Never suggest applying changes — that requires explicit human approval
- If terraform plan fails, report the error clearly
- Prefer conservative fixes (restrict access, enable encryption) over destructive ones
"""

MAX_ITERATIONS = 6


# =============================================================================
# Helpers
# =============================================================================


def _mcp_tools_to_anthropic(mcp_tools: list) -> list:
    """
    Convert mcp.types.Tool objects (returned by Client.list_tools) to the
    Anthropic tool-use format. Only the key name differs: inputSchema → input_schema.
    """
    return [
        {
            "name":         t.name,
            "description":  t.description or t.name,
            "input_schema": t.inputSchema or {},
        }
        for t in mcp_tools
    ]


def _extract_result(mcp_result) -> dict:
    """
    Parse a FastMCP CallToolResult into a plain dict safe for JSON serialisation.
    Mirrors the same fallback chain used in docs_generator.py handlers.
    """
    if mcp_result.is_error:
        return {"error": str(mcp_result.data)}
    if isinstance(mcp_result.data, dict):
        return mcp_result.data
    if isinstance(mcp_result.data, list):
        return {"result": mcp_result.data}
    if mcp_result.data is not None:
        return {"result": mcp_result.data}
    if mcp_result.content:
        try:
            return json.loads(mcp_result.content[0].text)
        except Exception:
            return {"result": mcp_result.content[0].text}
    return {}


# =============================================================================
# run_security_agent
# =============================================================================


async def run_security_agent(credentials: dict, issue_index: int = 0) -> dict:
    """
    Full agentic loop. Autonomous from scan to plan.
    Returns plan + summary for human approval. Never applies changes.

    All tool calls go through FastMCP Client — pure MCP, no dispatch_tool bypass.
    """
    # ------------------------------------------------------------------
    # Step 1: Scan live AWS state — run all five scanners concurrently
    # ------------------------------------------------------------------
    region = credentials.get("region", "us-east-1")

    ec2_res, s3_res, iam_res, sg_res, vpc_res = await asyncio.gather(
        asyncio.to_thread(scan_ec2, region, credentials),
        asyncio.to_thread(scan_s3, credentials),
        asyncio.to_thread(scan_iam, credentials),
        asyncio.to_thread(scan_security_groups, region, credentials),
        asyncio.to_thread(scan_vpc, region, credentials),
    )
    scan_data = {
        "ec2":             ec2_res,
        "s3":              s3_res,
        "iam":             iam_res,
        "security_groups": sg_res,
        "vpc":             vpc_res,
    }

    # ------------------------------------------------------------------
    # Step 2: Extract security findings, sorted HIGH → MEDIUM → LOW
    # ------------------------------------------------------------------
    findings = run_security_analysis(scan_data)

    if not findings:
        return {"status": "no_issues"}

    target_index = min(issue_index, len(findings) - 1)
    target_issue = findings[target_index]

    # ------------------------------------------------------------------
    # Step 3: Build initial message with all findings + the target issue
    # ------------------------------------------------------------------
    initial_message = (
        f"Here are the AWS security findings from a live scan:\n\n"
        f"```json\n{json.dumps(findings, indent=2, default=str)}\n```\n\n"
        f"Please fix the following highest-priority issue (index {target_index}):\n\n"
        f"```json\n{json.dumps(target_issue, indent=2, default=str)}\n```\n\n"
        f"Follow the four-step process: generate_terraform_from_request → "
        f"run_terraform_plan_mcp → summarise_plan_for_human."
    )

    # ------------------------------------------------------------------
    # Step 4: Agentic loop — all tool calls go through FastMCP Client
    # ------------------------------------------------------------------
    api_key = credentials.get("anthropic_api_key") or os.getenv("ANTHROPIC_API_KEY", "")
    anthropic_client = anthropic.Anthropic(api_key=api_key)

    # State collected across iterations
    collected_hcl         = ""
    collected_plan_output = ""
    collected_summary     = ""
    execution_id          = ""
    plan_was_run_in_loop  = False
    iteration             = 0

    async with Client(mcp) as mcp_client:
        # Single source of truth for tool definitions
        mcp_tools       = await mcp_client.list_tools()
        anthropic_tools = _mcp_tools_to_anthropic(mcp_tools)

        messages = [{"role": "user", "content": initial_message}]

        for iteration in range(MAX_ITERATIONS):
            response = anthropic_client.messages.create(
                model="claude-opus-4-5",
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=anthropic_tools,
                messages=messages,
            )
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "end_turn":
                break
            if response.stop_reason != "tool_use":
                break

            tool_results = []

            for block in response.content:
                if block.type != "tool_use":
                    continue

                tool_name  = block.name
                tool_input = dict(block.input)

                # Inject AWS credentials for tools that operate on live infra
                if tool_name in ("generate_terraform_from_request", "run_terraform_plan_mcp"):
                    tool_input.setdefault("aws_access_key_id",     credentials.get("aws_access_key_id", ""))
                    tool_input.setdefault("aws_secret_access_key", credentials.get("aws_secret_access_key", ""))
                    tool_input.setdefault("aws_region",            credentials.get("region", "us-east-1"))

                # Route all calls through MCP — no bypass
                mcp_result  = await mcp_client.call_tool(tool_name, tool_input)
                result_dict = _extract_result(mcp_result)

                # Collect artefacts from tool responses
                if tool_name == "generate_terraform_from_request":
                    collected_hcl = result_dict.get("hcl", "")
                elif tool_name == "run_terraform_plan_mcp":
                    collected_plan_output = result_dict.get("plan_output", "")
                    execution_id          = result_dict.get("execution_id", "")
                    plan_was_run_in_loop  = True
                elif tool_name == "summarise_plan_for_human":
                    collected_summary = result_dict.get("summary", "")

                tool_results.append({
                    "type":        "tool_result",
                    "tool_use_id": block.id,
                    "content":     json.dumps(result_dict, default=str),
                })

            if not tool_results:
                break

            messages.append({"role": "user", "content": tool_results})

    # ------------------------------------------------------------------
    # Step 5: Fallback — only if the agent loop never called run_terraform_plan_mcp
    # ------------------------------------------------------------------
    if collected_hcl and not plan_was_run_in_loop:
        execution_id = create_execution_id()
        plan_result  = run_terraform_plan(collected_hcl, execution_id)
        collected_plan_output = plan_result.get("plan_output", "")
        log_execution({
            "execution_id": execution_id,
            "timestamp":    datetime.now(timezone.utc).isoformat(),
            "status":       "awaiting_approval" if plan_result.get("success") else "plan_failed",
            "issue":        target_issue,
            "hcl":          collected_hcl,
            "plan_output":  collected_plan_output,
            "summary":      collected_summary,
            "plan_success": plan_result.get("success", False),
            "approved":     None,
            "apply_output": None,
        })
    elif execution_id:
        # run_terraform_plan_mcp already created the log entry via log_execution.
        # Update it with agent-specific fields not available to the MCP tool.
        log_execution_update(execution_id, {
            "status":       "awaiting_approval",
            "issue":        target_issue,
            "hcl":          collected_hcl,
            "summary":      collected_summary,
        })

    return {
        "status":       "awaiting_approval",
        "execution_id": execution_id,
        "issue":        target_issue,
        "hcl":          collected_hcl,
        "plan_output":  collected_plan_output,
        "summary":      collected_summary,
        "plan_success": bool(collected_plan_output),
    }


# =============================================================================
# approve_and_apply
# =============================================================================


async def approve_and_apply(execution_id: str, credentials: dict) -> dict:
    """
    Called only when human explicitly approves.
    Runs terraform apply on the saved plan file.
    Updates execution state throughout.
    Returns {status: "complete"/"failed", output: str}
    """
    log_execution_update(execution_id, {"status": "applying", "approved": True})

    apply_result = run_terraform_apply(execution_id)
    success      = apply_result.get("success", False)

    log_execution_update(execution_id, {
        "status":       "complete" if success else "failed",
        "apply_output": apply_result.get("apply_output", ""),
    })

    return {
        "status": "complete" if success else "failed",
        "output": apply_result.get("apply_output", ""),
    }
