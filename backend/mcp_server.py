# MCP SERVER — Agentic Cloud Assistant (HTTP Transport)
# Exposes all backend capabilities as MCP tools over POST /mcp.
# Claude Desktop/Code connects via the MCP protocol.
# The React frontend calls the same endpoint via a thin JSON-RPC client.
# The old Tool Use API (TOOLS list, dispatch_tool, agent loop) is gone.

import asyncio
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import httpx
from fastmcp import FastMCP
from fastmcp.server.http import create_streamable_http_app
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
import uvicorn

from services.aws_scanner import (
    scan_ec2,
    scan_iam,
    scan_s3,
    scan_security_groups,
    scan_vpc,
)
from services.cost_analyzer import (
    detect_cost_anomaly,
    get_cost_by_service,
    get_current_month_cost,
    get_monthly_trend,
)
from services.execution_service import (
    create_execution_id,
    get_execution_history,
    log_execution,
    log_execution_update,
    run_terraform_apply,
    run_terraform_plan,
)
from services.llm_service import (
    chat_with_anthropic,
    chat_with_groq,
    chat_with_ollama,
)
from services.security_analyzer import run_security_analysis
from services.terraform_service import generate_terraform, validate_terraform_syntax

mcp = FastMCP("agentic-cloud-assistant")


# =============================================================================
# Internal helper — call an LLM with a plain prompt (no scan-data system prompt)
# =============================================================================

async def _llm(prompt: str, model: str = "groq", api_key: str = "") -> str:
    """Send a single prompt to the configured LLM. Returns the reply string."""
    key = api_key.strip() if api_key else None

    if model == "anthropic":
        resolved = key or os.getenv("ANTHROPIC_API_KEY", "")
        if not resolved:
            return "No Anthropic API key available."
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": resolved,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 1024,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            data = resp.json()
            if resp.status_code != 200:
                return f"Anthropic error: {data.get('error', {}).get('message', str(data))}"
            return data["content"][0]["text"]

    else:  # groq (default)
        resolved = key or os.getenv("GROQ_API_KEY", "")
        if not resolved:
            return "No Groq API key available."
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {resolved}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.3,
                    "max_tokens": 1024,
                },
            )
            data = resp.json()
            if resp.status_code != 200:
                return f"Groq error: {data.get('error', {}).get('message', str(data))}"
            return data["choices"][0]["message"]["content"]


# =============================================================================
# GROUP A — AWS Scanning
# =============================================================================


@mcp.tool()
def health_check() -> dict:
    """Returns server status. Used to verify MCP connection."""
    return {"status": "ok", "server": "agentic-cloud-assistant"}


@mcp.tool()
def full_aws_scan(region: str = "us-east-1") -> dict:
    """Run all five AWS service scans and return combined infrastructure data.

    Calls EC2, S3, IAM, Security Groups, and VPC scanners in sequence.
    Used by the Dashboard Infrastructure Overview panel.

    Args:
        region: AWS region identifier, e.g. "us-east-1". Defaults to "us-east-1".

    Returns:
        A dict with keys: ec2, s3, iam, security_groups, vpc — each the full
        scan result from the corresponding scanner.
    """
    return {
        "ec2": scan_ec2(region=region),
        "s3": scan_s3(),
        "iam": scan_iam(),
        "security_groups": scan_security_groups(region=region),
        "vpc": scan_vpc(region=region),
    }


@mcp.tool()
def scan_ec2_instances(region: str = "us-east-1") -> dict:
    """Scan all EC2 instances in the specified AWS region.

    Args:
        region: AWS region identifier. Defaults to "us-east-1".

    Returns:
        {"status", "count", "instances": [{"id","name","type","state",
         "public_ip","private_ip","launch_time","security_group_ids"}]}
    """
    return scan_ec2(region=region)


@mcp.tool()
def scan_s3_buckets() -> dict:
    """Scan all S3 buckets and check public-access status.

    Returns:
        {"status", "count", "buckets": [{"name","created","is_public"}]}
    """
    return scan_s3()


@mcp.tool()
def scan_iam_users() -> dict:
    """Scan all IAM users and check MFA status and last-login date.

    Returns:
        {"status", "user_count", "users": [{"username","user_id","created",
         "has_mfa","last_login"}]}
    """
    return scan_iam()


@mcp.tool()
def scan_security_groups_detail(region: str = "us-east-1") -> dict:
    """Scan all EC2 security groups and flag dangerous internet-facing rules.

    Args:
        region: AWS region identifier. Defaults to "us-east-1".

    Returns:
        {"status", "count", "security_groups": [{"id","name","description",
         "vpc_id","open_to_internet","is_dangerous"}]}
    """
    return scan_security_groups(region=region)


@mcp.tool()
def scan_vpc_detail(region: str = "us-east-1") -> dict:
    """Scan all VPCs including subnet counts.

    Args:
        region: AWS region identifier. Defaults to "us-east-1".

    Returns:
        {"status", "count", "vpcs": [{"id","name","cidr","is_default",
         "state","subnet_count"}]}
    """
    return scan_vpc(region=region)


# =============================================================================
# GROUP B — Security Analysis & Cost
# =============================================================================


@mcp.tool()
def analyse_security_findings(scan_data: dict) -> dict:
    """Run 7 built-in security rules against raw AWS scan data.

    Args:
        scan_data: Combined dict from scan tools. Keys: ec2, s3, iam,
                   security_groups, vpc. Missing keys handled safely.

    Returns:
        {"total_findings", "severity_counts": {"HIGH","MEDIUM","LOW"},
         "findings": [...sorted HIGH→MEDIUM→LOW...]}
    """
    findings = run_security_analysis(scan_data)
    counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for f in findings:
        sev = f.get("severity", "LOW")
        counts[sev] = counts.get(sev, 0) + 1
    return {"total_findings": len(findings), "severity_counts": counts, "findings": findings}


@mcp.tool()
async def run_security_analysis_with_summary(
    region: str = "us-east-1",
    model: str = "groq",
    api_key: str = "",
) -> dict:
    """Scan AWS, run security rules, and generate an LLM plain-English summary.

    Runs all five scanners then applies 7 security rules and asks an LLM to
    summarise the findings. This is the one-call equivalent of the old
    GET /security endpoint.

    Args:
        region:  AWS region to scan. Defaults to "us-east-1".
        model:   LLM provider — "groq" (default), "anthropic", or "ollama".
        api_key: Optional API key override. Falls back to server .env keys.

    Returns:
        {"findings", "severity_counts", "llm_summary", "total_findings"}
    """
    scan_data = {
        "ec2": scan_ec2(region=region),
        "s3": scan_s3(),
        "iam": scan_iam(),
        "security_groups": scan_security_groups(region=region),
        "vpc": scan_vpc(region=region),
    }

    findings = run_security_analysis(scan_data)
    counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for f in findings:
        sev = f.get("severity", "LOW")
        counts[sev] = counts.get(sev, 0) + 1

    if findings:
        summary_prompt = (
            f"You are an AWS security expert. Summarise these {len(findings)} "
            f"security findings in 2-3 concise paragraphs for a cloud engineer:\n\n"
            + json.dumps(
                [
                    {
                        "severity": f.get("severity"),
                        "title": f.get("title"),
                        "resource_id": f.get("resource_id"),
                        "recommendation": f.get("recommendation"),
                    }
                    for f in findings
                ],
                indent=2,
            )
        )
        llm_summary = await _llm(summary_prompt, model, api_key)
    else:
        llm_summary = "No security issues found. Your AWS infrastructure looks clean."

    return {
        "findings": findings,
        "severity_counts": counts,
        "total_findings": len(findings),
        "llm_summary": llm_summary,
    }


@mcp.tool()
def estimate_costs(region: str = "us-east-1", time_period_days: int = 30) -> dict:
    """Retrieve AWS spend data and detect cost anomalies via Cost Explorer.

    Args:
        region:           Accepted but ignored — Cost Explorer is global.
        time_period_days: Look-back window converted to months. Defaults to 30.

    Returns:
        {"current_month", "monthly_trend", "by_service", "anomaly", "months_fetched"}
    """
    months = max(1, time_period_days // 30)
    monthly_trend = get_monthly_trend(months=months)
    return {
        "current_month": get_current_month_cost(),
        "monthly_trend": monthly_trend,
        "by_service": get_cost_by_service(),
        "anomaly": detect_cost_anomaly(monthly_trend),
        "months_fetched": months,
    }


@mcp.tool()
async def get_cost_with_summary(
    region: str = "us-east-1",
    model: str = "groq",
    api_key: str = "",
) -> dict:
    """Retrieve AWS cost data and generate an LLM cost-optimisation summary.

    One-call equivalent of the old GET /cost endpoint.

    Args:
        region:  Accepted but ignored — Cost Explorer is global.
        model:   LLM provider — "groq" (default), "anthropic", or "ollama".
        api_key: Optional API key override.

    Returns:
        {"current_month", "monthly_trend", "by_service", "anomaly", "llm_summary"}
    """
    monthly_trend = get_monthly_trend(months=3)
    current_month = get_current_month_cost()
    by_service = get_cost_by_service()
    anomaly = detect_cost_anomaly(monthly_trend)

    cost_summary = {
        "current_month": current_month,
        "monthly_trend": monthly_trend,
        "by_service": by_service[:5],
        "anomaly": anomaly,
    }

    summary_prompt = (
        "You are an AWS cost-optimisation expert. Analyse this cost data and "
        "provide 3-4 actionable recommendations in plain English:\n\n"
        + json.dumps(cost_summary, indent=2, default=str)
    )
    llm_summary = await _llm(summary_prompt, model, api_key)

    return {
        "current_month": current_month,
        "monthly_trend": monthly_trend,
        "by_service": by_service,
        "anomaly": anomaly,
        "llm_summary": llm_summary,
    }


# =============================================================================
# GROUP C — Terraform Generation & Execution
# =============================================================================


@mcp.tool()
async def generate_terraform_hcl(resource_type: str, config: dict) -> dict:
    """Generate Terraform HCL from a resource type and config dict.

    Args:
        resource_type: Plain-English or Terraform resource name.
        config:        Configuration options dict. Pass {} for LLM defaults.

    Returns:
        {"hcl", "explanation", "valid", "validation_message", "resource_type", "error"}
    """
    model = "anthropic" if os.getenv("ANTHROPIC_API_KEY") else "groq"
    api_key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("GROQ_API_KEY", "")
    config_detail = (
        f" with the following configuration:\n{json.dumps(config, indent=2)}"
        if config
        else ""
    )
    request = f"Create a {resource_type}{config_detail}"
    result = await generate_terraform(request, model, api_key)
    return {
        "hcl": result.get("hcl", ""),
        "explanation": result.get("description", ""),
        "valid": result.get("validation", {}).get("valid", False),
        "validation_message": result.get("validation", {}).get("message", ""),
        "resource_type": result.get("resource_type", "unknown"),
        "error": result.get("error"),
    }


@mcp.tool()
async def generate_terraform_from_request(
    request: str,
    model: str = "groq",
    api_key: str = "",
) -> dict:
    """Generate Terraform HCL from a plain-English request string.

    Equivalent to the old POST /terraform/generate endpoint. Accepts a
    free-text description and returns structured HCL with validation result.

    Args:
        request: Plain-English description, e.g. "Create an EC2 t3.micro instance".
        model:   LLM provider — "groq" (default) or "anthropic".
        api_key: Optional API key override. Falls back to server .env keys.

    Returns:
        {"hcl", "validation": {"valid","message"}, "resource_type", "description", "error"}
    """
    resolved_model = model or ("anthropic" if os.getenv("ANTHROPIC_API_KEY") else "groq")
    resolved_key = (
        api_key.strip()
        or (
            os.getenv("ANTHROPIC_API_KEY")
            if resolved_model == "anthropic"
            else os.getenv("GROQ_API_KEY", "")
        )
    )

    result = await generate_terraform(request, resolved_model, resolved_key)

    return {
        "hcl": result.get("hcl", ""),
        "validation": result.get("validation", {"valid": False, "message": ""}),
        "resource_type": result.get("resource_type", "unknown"),
        "description": result.get("description", ""),
        "error": result.get("error"),
    }


@mcp.tool()
def validate_terraform_plan(hcl: str) -> dict:
    """Validate Terraform HCL syntax without touching AWS.

    Args:
        hcl: Complete Terraform HCL including terraform{}, provider{}, resource{}.

    Returns:
        {"valid", "errors": [...], "warnings": [...], "message"}
    """
    result = validate_terraform_syntax(hcl)
    raw_message = result.get("message", "")
    errors, warnings = [], []
    if not result.get("valid", False):
        for line in raw_message.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if "warning" in stripped.lower():
                warnings.append(stripped)
            else:
                errors.append(stripped)
    return {
        "valid": result.get("valid", False),
        "errors": errors,
        "warnings": warnings,
        "message": raw_message,
    }


@mcp.tool()
async def run_terraform_plan_mcp(hcl_config: str, description: str = "") -> dict:
    """Write HCL to a persistent working directory, run terraform init + plan.

    Equivalent to the old POST /terraform/plan endpoint. READ-ONLY — never
    modifies AWS. Saves an execution_id for a subsequent apply call.

    Args:
        hcl_config:  Complete Terraform HCL as a string.
        description: Plain-English label for the execution log.

    Returns:
        {"execution_id", "status": "awaiting_approval"|"plan_failed",
         "plan_output", "resources_to_add", "resources_to_change", "resources_to_destroy"}
    """
    execution_id = create_execution_id()
    plan_result = await asyncio.to_thread(run_terraform_plan, hcl_config, execution_id)

    status = "awaiting_approval" if plan_result["success"] else "plan_failed"
    log_execution(
        {
            "execution_id": execution_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "description": description or "Terraform plan",
            "plan_output": plan_result.get("plan_output", ""),
            "resources_to_add": plan_result.get("resources_to_add", 0),
            "resources_to_change": plan_result.get("resources_to_change", 0),
            "resources_to_destroy": plan_result.get("resources_to_destroy", 0),
        }
    )

    return {
        "execution_id": execution_id,
        "status": status,
        "plan_output": plan_result.get("plan_output", ""),
        "resources_to_add": plan_result.get("resources_to_add", 0),
        "resources_to_change": plan_result.get("resources_to_change", 0),
        "resources_to_destroy": plan_result.get("resources_to_destroy", 0),
    }


@mcp.tool()
def run_terraform_apply_mcp(execution_id: str, approved: bool) -> dict:
    """Apply or reject a previously planned Terraform execution.

    Equivalent to the old POST /terraform/apply endpoint. The human-in-the-loop
    gate: if approved=False, logs rejection and returns immediately without
    touching AWS.

    Args:
        execution_id: Must match the ID returned by run_terraform_plan_mcp.
        approved:     True to apply; False to reject.

    Returns:
        {"status": "complete"|"failed"|"rejected",
         "apply_output": str, "resources_applied": list}
    """
    if not approved:
        log_execution_update(execution_id, {"status": "rejected"})
        return {"status": "rejected", "apply_output": "", "resources_applied": []}

    apply_result = run_terraform_apply(execution_id)
    status = "complete" if apply_result.get("success") else "failed"
    log_execution_update(
        execution_id,
        {
            "status": status,
            "apply_output": apply_result.get("apply_output", ""),
            "resources_applied": apply_result.get("resources_applied", []),
        },
    )
    return {
        "status": status,
        "apply_output": apply_result.get("apply_output", ""),
        "resources_applied": apply_result.get("resources_applied", []),
    }


@mcp.tool()
def get_execution_history_tool() -> dict:
    """Return all past Terraform plan/apply executions from the execution log.

    Equivalent to the old GET /terraform/executions endpoint.

    Returns:
        {"executions": [...all log entries...]}
    """
    return {"executions": get_execution_history()}


# =============================================================================
# GROUP D — Chat & Autonomous Agent
# =============================================================================


@mcp.tool()
async def aws_chat(
    message: str,
    model: str = "groq",
    api_key: str = "",
    history: list = None,
    region: str = "us-east-1",
) -> dict:
    """Chat with an LLM about your live AWS infrastructure.

    Runs a full five-service scan first so the LLM has current account data
    as context. Equivalent to the old POST /chat endpoint.

    Args:
        message: User's question about their infrastructure.
        model:   "groq" (default), "anthropic", or "ollama".
        api_key: Optional API key override.
        history: Previous conversation turns [{"role","content"}, ...].
        region:  AWS region to scan for context. Defaults to "us-east-1".

    Returns:
        {"reply": str}
    """
    history = history or []
    resolved_key = api_key.strip() if api_key else None

    scan_data = {
        "ec2": scan_ec2(region=region),
        "s3": scan_s3(),
        "iam": scan_iam(),
        "security_groups": scan_security_groups(region=region),
        "vpc": scan_vpc(region=region),
    }

    if model == "anthropic":
        key = resolved_key or os.getenv("ANTHROPIC_API_KEY")
        reply = await chat_with_anthropic(message, scan_data, history, key)
    elif model == "ollama":
        reply = await chat_with_ollama(message, scan_data, history)
    else:
        key = resolved_key or os.getenv("GROQ_API_KEY")
        reply = await chat_with_groq(message, scan_data, history, key)

    return {"reply": reply}


@mcp.tool()
async def agent_run(
    region: str = "us-east-1",
    model: str = "groq",
    api_key: str = "",
) -> dict:
    """Autonomous security remediation agent — scan, pick top issue, generate fix, plan.

    Replaces the old POST /agent/run endpoint. Orchestrates the full pipeline:
      1. Scan all AWS services
      2. Run security analysis
      3. Pick the highest-severity finding
      4. Generate Terraform HCL to fix it (using the configured LLM)
      5. Run terraform plan
      6. Generate a plain-English summary for human review

    Args:
        region:  AWS region to scan. Defaults to "us-east-1".
        model:   LLM provider — "groq" (default) or "anthropic".
        api_key: Optional API key override. Falls back to server .env keys.

    Returns:
        {"status": "awaiting_approval"|"no_issues"|"error",
         "execution_id", "issue", "hcl", "plan_output",
         "resources_to_add", "resources_to_change", "resources_to_destroy",
         "summary", "error"}
    """
    # 1. Scan
    scan_data = {
        "ec2": scan_ec2(region=region),
        "s3": scan_s3(),
        "iam": scan_iam(),
        "security_groups": scan_security_groups(region=region),
        "vpc": scan_vpc(region=region),
    }

    # 2. Analyse
    findings = run_security_analysis(scan_data)
    if not findings:
        return {"status": "no_issues", "message": "No security issues found."}

    # 3. Top finding
    issue = findings[0]

    # 4. Generate Terraform fix
    fix_request = (
        f"Fix security issue: '{issue['title']}' on "
        f"{issue['resource_type']} {issue['resource_id']}. "
        f"{issue['recommendation']}"
    )
    resolved_model = model.strip() if model.strip() else (
        "anthropic" if os.getenv("ANTHROPIC_API_KEY") else "groq"
    )
    resolved_key = api_key.strip() or (
        os.getenv("ANTHROPIC_API_KEY") if resolved_model == "anthropic"
        else os.getenv("GROQ_API_KEY", "")
    )

    terraform_result = await generate_terraform(fix_request, resolved_model, resolved_key)
    if terraform_result.get("error"):
        return {"status": "error", "error": terraform_result["error"]}

    hcl = terraform_result.get("hcl", "")

    # 5. Terraform plan (async thread so event loop isn't blocked)
    execution_id = create_execution_id()
    plan_result = await asyncio.to_thread(run_terraform_plan, hcl, execution_id)

    # 6. LLM summary for human review
    plan_snippet = plan_result.get("plan_output", "")[:2000]
    summary_prompt = (
        f"Summarise this planned AWS infrastructure change in 2-3 sentences "
        f"for a non-expert to review before approving:\n\n"
        f"Issue: {issue['title']}\n"
        f"Resource: {issue['resource_type']} {issue['resource_id']}\n"
        f"Changes: +{plan_result.get('resources_to_add',0)} "
        f"~{plan_result.get('resources_to_change',0)} "
        f"-{plan_result.get('resources_to_destroy',0)}\n\n"
        f"Plan:\n{plan_snippet}"
    )
    summary = await _llm(summary_prompt, resolved_model, resolved_key)

    # Log to execution history
    log_execution(
        {
            "execution_id": execution_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": "awaiting_approval",
            "description": fix_request,
            "issue": issue,
            "hcl": hcl,
            "plan_output": plan_result.get("plan_output", ""),
            "resources_to_add": plan_result.get("resources_to_add", 0),
            "resources_to_change": plan_result.get("resources_to_change", 0),
            "resources_to_destroy": plan_result.get("resources_to_destroy", 0),
        }
    )

    return {
        "status": "awaiting_approval",
        "execution_id": execution_id,
        "issue": issue,
        "hcl": hcl,
        "plan_output": plan_result.get("plan_output", ""),
        "resources_to_add": plan_result.get("resources_to_add", 0),
        "resources_to_change": plan_result.get("resources_to_change", 0),
        "resources_to_destroy": plan_result.get("resources_to_destroy", 0),
        "summary": summary,
    }


@mcp.tool()
def agent_approve(execution_id: str, approved: bool) -> dict:
    """Approve or reject an agent-generated Terraform plan.

    Replaces the old POST /agent/approve/{id} endpoint. If approved, applies
    the saved tfplan file. If rejected, logs the decision and returns.

    Args:
        execution_id: ID returned by agent_run.
        approved:     True to apply; False to reject.

    Returns:
        {"status": "complete"|"failed"|"rejected",
         "apply_output": str, "resources_applied": list}
    """
    if not approved:
        log_execution_update(
            execution_id,
            {
                "status": "rejected",
                "approved_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {"status": "rejected", "apply_output": "", "resources_applied": []}

    apply_result = run_terraform_apply(execution_id)
    status = "complete" if apply_result.get("success") else "failed"
    log_execution_update(
        execution_id,
        {
            "status": status,
            "apply_output": apply_result.get("apply_output", ""),
            "resources_applied": apply_result.get("resources_applied", []),
            "approved_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return {
        "status": status,
        "apply_output": apply_result.get("apply_output", ""),
        "resources_applied": apply_result.get("resources_applied", []),
    }


# =============================================================================
# GROUP E — RAG Knowledge Base
# =============================================================================

try:
    from rag.knowledge_base import knowledge_base
    from rag.rag_service import query_knowledge_base
    _RAG_AVAILABLE = True
except Exception:
    _RAG_AVAILABLE = False


@mcp.tool()
async def rag_query_tool(
    question: str,
    n_results: int = 3,
    resource_type: str = "",
    groq_key: str = "",
) -> dict:
    """Search the security knowledge base and answer with LLM grounding.

    Retrieves relevant documentation chunks from ChromaDB, builds an
    augmented prompt, then calls Groq to produce a grounded answer.
    Equivalent to the old POST /rag/query endpoint.

    Args:
        question:      Security question to search for.
        n_results:     Max knowledge chunks to retrieve. Defaults to 3.
        resource_type: Optional filter — "ec2","s3","iam","vpc","terraform","general".
        groq_key:      Optional Groq API key override.

    Returns:
        {"answer", "sources": [...], "chunks_used": int, "raw_chunks": [...]}
    """
    if not _RAG_AVAILABLE:
        return {
            "answer": "RAG knowledge base is not available.",
            "sources": [],
            "chunks_used": 0,
            "raw_chunks": [],
        }

    result = query_knowledge_base(
        question,
        n_results=n_results,
        resource_filter=resource_type or None,
    )

    answer = await _llm(result["augmented_prompt"], model="groq", api_key=groq_key)

    return {
        "answer": answer,
        "sources": result["sources"],
        "chunks_used": result["chunks_used"],
        "raw_chunks": result["raw_chunks"],
    }


@mcp.tool()
def rag_list_documents() -> dict:
    """List all documents currently stored in the ChromaDB knowledge base.

    Equivalent to the old GET /rag/documents endpoint.

    Returns:
        {"documents": [{"doc_id","resource_type","chunk_count"}, ...]}
    """
    if not _RAG_AVAILABLE:
        return {"documents": []}

    try:
        collection = knowledge_base.collection
        result = collection.get(include=["metadatas"])
        docs: dict = {}
        for meta in result.get("metadatas") or []:
            doc_id = meta.get("doc_id", "unknown")
            if doc_id not in docs:
                docs[doc_id] = {
                    "doc_id": doc_id,
                    "resource_type": meta.get("resource_type", "general"),
                    "chunk_count": 0,
                }
            docs[doc_id]["chunk_count"] += 1
        return {"documents": list(docs.values())}
    except Exception as e:
        return {"documents": [], "error": str(e)}


@mcp.tool()
def rag_add_text_document(
    doc_id: str,
    text: str,
    resource_type: str = "general",
) -> dict:
    """Add a text document to the ChromaDB knowledge base.

    Equivalent to the old POST /rag/documents/text endpoint.
    Chunks the text, embeds each chunk, and stores in ChromaDB.

    Args:
        doc_id:        Unique identifier for this document.
        text:          Raw text content to chunk and embed.
        resource_type: Category — "ec2","s3","iam","vpc","terraform","general".

    Returns:
        {"chunks_added": int, "doc_id": str}
    """
    if not _RAG_AVAILABLE:
        return {"chunks_added": 0, "doc_id": doc_id, "error": "RAG not available"}

    result = knowledge_base.add_document(
        doc_id=doc_id,
        text=text,
        metadata={"resource_type": resource_type},
    )
    return {"chunks_added": result.get("chunks_added", 0), "doc_id": doc_id}


@mcp.tool()
def rag_delete_document(doc_id: str) -> dict:
    """Delete a document and all its chunks from the knowledge base.

    Equivalent to the old DELETE /rag/documents/{doc_id} endpoint.

    Args:
        doc_id: ID of the document to remove.

    Returns:
        {"deleted": bool, "message": str}
    """
    if not _RAG_AVAILABLE:
        return {"deleted": False, "message": "RAG not available"}

    try:
        collection = knowledge_base.collection
        results = collection.get(where={"doc_id": doc_id}, include=["metadatas"])
        ids = results.get("ids", [])
        if not ids:
            return {"deleted": False, "message": f"No chunks found for '{doc_id}'"}
        collection.delete(ids=ids)
        return {
            "deleted": True,
            "message": f"Deleted {len(ids)} chunks for '{doc_id}'",
        }
    except Exception as e:
        return {"deleted": False, "message": str(e)}


@mcp.tool()
def rag_upload_file(
    doc_id: str,
    file_content_base64: str,
    filename: str,
    resource_type: str = "general",
) -> dict:
    """Add a file (PDF or plain text) to the knowledge base from base64-encoded content.

    Accepts any file pre-encoded as base64. PDFs are parsed with PyPDF2 to
    extract selectable text. Plain text files are decoded as UTF-8.
    This is the MCP equivalent of the old POST /rag/documents/upload endpoint.

    Args:
        doc_id:              Unique identifier for this document.
        file_content_base64: Base64-encoded raw file bytes.
        filename:            Original filename — used to detect .pdf extension.
        resource_type:       Category — ec2, s3, iam, vpc, terraform, general.

    Returns:
        {"chunks_added": int, "doc_id": str, "error": str|null}
    """
    import base64
    import io

    if not _RAG_AVAILABLE:
        return {"chunks_added": 0, "doc_id": doc_id, "error": "RAG not available"}

    try:
        file_bytes = base64.b64decode(file_content_base64)
    except Exception as e:
        return {"chunks_added": 0, "doc_id": doc_id, "error": f"Base64 decode error: {e}"}

    if filename.lower().endswith(".pdf"):
        try:
            import PyPDF2
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
            pages = [page.extract_text() or "" for page in pdf_reader.pages]
            text = "\n\n".join(pages).strip()
        except Exception as e:
            return {"chunks_added": 0, "doc_id": doc_id, "error": f"PDF parse error: {e}"}
    else:
        text = file_bytes.decode("utf-8", errors="replace").strip()

    if not text:
        return {
            "chunks_added": 0,
            "doc_id": doc_id,
            "error": "No text could be extracted from the file.",
        }

    result = knowledge_base.add_document(
        doc_id=doc_id,
        text=text,
        metadata={"resource_type": resource_type, "filename": filename},
    )
    return {"chunks_added": result.get("chunks_added", 0), "doc_id": doc_id, "error": None}


# =============================================================================
# GROUP F — MCP Resources (pulled on demand, not injected into every prompt)
# =============================================================================


@mcp.resource("aws://findings/{region}")
def aws_findings_resource(region: str) -> dict:
    """Latest security findings for an AWS region, pulled on demand.

    URI pattern: aws://findings/{region}
    Example:     aws://findings/us-east-1
    """
    scan_data = {
        "ec2": scan_ec2(region=region),
        "s3": scan_s3(),
        "iam": scan_iam(),
        "security_groups": scan_security_groups(region=region),
        "vpc": scan_vpc(region=region),
    }
    findings = run_security_analysis(scan_data)
    counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for f in findings:
        counts[f.get("severity", "LOW")] = counts.get(f.get("severity", "LOW"), 0) + 1
    return {
        "region": region,
        "total_findings": len(findings),
        "severity_counts": counts,
        "findings": findings,
    }


@mcp.resource("aws://cost-summary/{region}")
def aws_cost_summary_resource(region: str) -> dict:
    """Latest AWS cost summary for the account, pulled on demand.

    URI pattern: aws://cost-summary/{region}
    Note: Cost Explorer is global — region is informational only.
    """
    monthly_trend = get_monthly_trend(months=3)
    return {
        "region": region,
        "current_month": get_current_month_cost(),
        "monthly_trend": monthly_trend,
        "by_service": get_cost_by_service(),
        "anomaly": detect_cost_anomaly(monthly_trend),
    }


# =============================================================================
# HTTP file-upload endpoint (multipart — cannot be an MCP tool parameter)
# =============================================================================

async def _upload_document_endpoint(request: Request) -> JSONResponse:
    """POST /rag/documents/upload — multipart file upload to ChromaDB."""
    try:
        form = await request.form()
        file = form.get("file")
        doc_id = str(form.get("doc_id", ""))
        resource_type = str(form.get("resource_type", "general"))

        if not file or not doc_id.strip():
            return JSONResponse(
                {"message": "file and doc_id are required"}, status_code=422
            )

        content = await file.read()
        text = content.decode("utf-8", errors="ignore")

        if not _RAG_AVAILABLE:
            return JSONResponse({"message": "RAG not available"}, status_code=500)

        result = knowledge_base.add_document(
            doc_id=doc_id,
            text=text,
            metadata={"resource_type": resource_type},
        )
        return JSONResponse(
            {"chunks_added": result.get("chunks_added", 0), "doc_id": doc_id}
        )
    except Exception as e:
        return JSONResponse({"message": str(e)}, status_code=500)


# =============================================================================
# Application factory — HTTP transport + CORS
# =============================================================================

def create_app():
    from starlette.routing import Route

    base_app = create_streamable_http_app(mcp, streamable_http_path="/mcp")

    # Append the file-upload route to the existing Starlette router
    base_app.router.routes.append(
        Route(
            "/rag/documents/upload",
            _upload_document_endpoint,
            methods=["POST"],
        )
    )

    base_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["mcp-session-id"],
    )

    return base_app


if __name__ == "__main__":
    import sys

    # stdio mode: launched by Claude Desktop as a subprocess.
    # Pass --stdio (or set MCP_TRANSPORT=stdio) to enable.
    if "--stdio" in sys.argv or os.getenv("MCP_TRANSPORT") == "stdio":
        mcp.run()  # FastMCP stdio transport — Claude Desktop reads/writes stdin/stdout
    else:
        # HTTP mode: React frontend connects via JSON-RPC at POST /mcp.
        app = create_app()
        print("MCP server starting on http://localhost:8000")
        print("  MCP endpoint : POST http://localhost:8000/mcp")
        print("  File upload  : POST http://localhost:8000/rag/documents/upload")
        print("  Claude Code  : add url http://localhost:8000/mcp to MCP config")
        print("  Claude Desktop: run with --stdio flag instead")
        uvicorn.run(app, host="0.0.0.0", port=8000)
