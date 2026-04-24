import json
import os
from datetime import datetime, timezone

import anthropic
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
from services.terraform_service import TOOLS, dispatch_tool

# =============================================================================
# System prompt for the agentic loop
# =============================================================================

SYSTEM_PROMPT = """You are a cloud security remediation agent for AWS infrastructure.

You will receive AWS infrastructure scan results containing security findings.

Your task:
1. Identify the single highest-priority security issue from the findings
2. Use generate_terraform to create a Terraform fix for that issue
3. Use run_terraform_plan to validate and plan the change
4. Use summarise_plan_for_human to produce a clear approval summary

Rules:
- Fix ONE issue per run — do not attempt to fix multiple issues at once
- Always plan before summarising — never summarise without a plan
- Never suggest applying changes — that requires explicit human approval
- If terraform plan fails, report the error clearly
- Prefer conservative fixes (restrict access, enable encryption) over destructive ones
"""

# Maximum number of agentic loop iterations to prevent runaway loops
MAX_ITERATIONS = 6


# =============================================================================
# run_security_agent
# =============================================================================


async def run_security_agent(credentials: dict, issue_index: int = 0) -> dict:
    """
    Full agentic loop. Autonomous from scan to plan.
    Returns plan + summary for human approval. Never applies changes.

    Steps:
    1. Scan live AWS state using credentials
    2. Extract security findings via run_security_analysis
    3. If no findings, return {status: "no_issues"}
    4. Build initial message with scan results and target issue
    5. Run agentic loop: call Anthropic with TOOLS, process tool calls via
       dispatch_tool, feed results back
    6. Loop max MAX_ITERATIONS iterations for safety
    7. Create execution record via log_execution
    8. Return {status: "awaiting_approval", execution_id, issue, hcl,
               plan_output, summary}
    """
    # ------------------------------------------------------------------
    # Step 1: Scan live AWS state
    # ------------------------------------------------------------------
    region = credentials.get("region", "us-east-1")

    scan_data = {
        "ec2": scan_ec2(region, credentials=credentials),
        "s3": scan_s3(credentials=credentials),
        "iam": scan_iam(credentials=credentials),
        "security_groups": scan_security_groups(region, credentials=credentials),
        "vpc": scan_vpc(region, credentials=credentials),
    }

    # ------------------------------------------------------------------
    # Step 2: Extract security findings, sorted HIGH → MEDIUM → LOW
    # ------------------------------------------------------------------
    findings = run_security_analysis(scan_data)

    if not findings:
        return {"status": "no_issues"}

    # ------------------------------------------------------------------
    # Step 3: Select the target issue by index (default: highest priority)
    # ------------------------------------------------------------------
    target_index = min(issue_index, len(findings) - 1)
    target_issue = findings[target_index]

    # ------------------------------------------------------------------
    # Step 4: Build initial message with all findings + the target issue
    # ------------------------------------------------------------------
    findings_text = json.dumps(findings, indent=2, default=str)
    target_text = json.dumps(target_issue, indent=2, default=str)

    initial_message = (
        f"Here are the AWS security findings from a live scan:\n\n"
        f"```json\n{findings_text}\n```\n\n"
        f"Please fix the following highest-priority issue (index {target_index}):\n\n"
        f"```json\n{target_text}\n```\n\n"
        f"Follow the four-step process: generate_terraform → run_terraform_plan "
        f"→ summarise_plan_for_human."
    )

    # ------------------------------------------------------------------
    # Step 5: Run the agentic loop
    # ------------------------------------------------------------------
    api_key = credentials.get("anthropic_api_key") or os.getenv("ANTHROPIC_API_KEY", "")
    client = anthropic.Anthropic(api_key=api_key)

    messages = [{"role": "user", "content": initial_message}]

    # State collected across iterations
    collected_hcl = ""
    collected_plan_output = ""
    collected_summary = ""
    iteration = 0

    while iteration < MAX_ITERATIONS:
        iteration += 1

        response = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        # Append the assistant's response to the conversation
        messages.append({"role": "assistant", "content": response.content})

        # Check stop reason
        if response.stop_reason == "end_turn":
            # Model finished without requesting more tool calls
            break

        if response.stop_reason != "tool_use":
            # Unexpected stop reason — exit the loop
            break

        # ------------------------------------------------------------------
        # Process all tool_use blocks in this response
        # ------------------------------------------------------------------
        tool_results = []

        for block in response.content:
            if block.type != "tool_use":
                continue

            tool_name = block.name
            tool_input = block.input
            tool_id = block.id

            # Dispatch to the appropriate handler
            result = dispatch_tool(tool_name, tool_input)

            # Collect key artefacts for the return value
            if tool_name == "generate_terraform":
                collected_hcl = result.get("hcl", "")

            elif tool_name == "run_terraform_plan":
                collected_plan_output = result.get("plan_output", "")

            elif tool_name == "summarise_plan_for_human":
                collected_summary = result.get("summary", "")

            # Format result as a JSON string for the tool_result content block
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": json.dumps(result, default=str),
                }
            )

        if not tool_results:
            # No tool calls were found despite stop_reason == tool_use
            break

        # Feed all tool results back to the model in one user turn
        messages.append({"role": "user", "content": tool_results})

    # ------------------------------------------------------------------
    # Step 6: If the agentic loop produced HCL, run a persistent plan
    #         via execution_service so approve_and_apply can apply it.
    # ------------------------------------------------------------------
    execution_id = create_execution_id()

    if collected_hcl:
        plan_result = run_terraform_plan(collected_hcl, execution_id)
        # Use the execution_service plan output if available (it runs the
        # persistent plan that approve_and_apply will use).
        if plan_result.get("plan_output"):
            collected_plan_output = plan_result["plan_output"]
    else:
        plan_result = {"success": False, "plan_output": "No HCL was generated."}

    # ------------------------------------------------------------------
    # Step 7: Create an execution log entry
    # ------------------------------------------------------------------
    log_entry = {
        "execution_id": execution_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "awaiting_approval",
        "issue": target_issue,
        "hcl": collected_hcl,
        "plan_output": collected_plan_output,
        "summary": collected_summary,
        "plan_success": plan_result.get("success", False),
        "iterations": iteration,
        "approved": None,
        "apply_output": None,
    }
    log_execution(log_entry)

    return {
        "status": "awaiting_approval",
        "execution_id": execution_id,
        "issue": target_issue,
        "hcl": collected_hcl,
        "plan_output": collected_plan_output,
        "summary": collected_summary,
        "plan_success": plan_result.get("success", False),
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
    # Mark execution as applying
    log_execution_update(
        execution_id,
        {
            "status": "applying",
            "approved": True,
        },
    )

    # Run terraform apply using the saved tfplan file
    apply_result = run_terraform_apply(execution_id)

    success = apply_result.get("success", False)
    apply_output = apply_result.get("apply_output", "")

    # Update the execution log with the final result
    log_execution_update(
        execution_id,
        {
            "status": "complete" if success else "failed",
            "apply_output": apply_output,
        },
    )

    return {
        "status": "complete" if success else "failed",
        "output": apply_output,
    }
