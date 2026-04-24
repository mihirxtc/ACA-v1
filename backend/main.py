from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv()

import asyncio
from datetime import datetime, timezone

# Import the agentic loop service.
import agent_service
from botocore.exceptions import ClientError as BotoClientError
from botocore.exceptions import NoCredentialsError
from services.aws_scanner import (
    scan_ec2,
    scan_iam,
    scan_s3,
    scan_security_groups,
    scan_vpc,
)

# Import the Week 5 cost analysis engine.
from services.cost_analyzer import (
    detect_cost_anomaly,
    get_cost_by_service,
    get_cost_insights_llm,
    get_current_month_cost,
    get_monthly_trend,
)

# Import the Week 7 execution engine.
from services.execution_service import (
    create_execution_id,
    get_execution_history,
    log_execution,
    log_execution_update,
    run_terraform_apply,
    run_terraform_plan,
)

# Import the three LLM provider functions added in Week 3.
from services.llm_service import (
    chat_with_anthropic,
    chat_with_groq,
    chat_with_ollama,
)
from rag.knowledge_base import knowledge_base
from rag.rag_service import query_knowledge_base
from fastapi import UploadFile, File, Form
from typing import Optional
import io
import PyPDF2

# Import the Week 4 security analysis engine.
from services.security_analyzer import (
    get_security_summary,
    run_security_analysis,
)

# Import the Week 6 Terraform generation engine.
from services.terraform_service import generate_terraform


class ChatRequest(BaseModel):
    message: str
    model: str = "groq"
    history: list = []
    api_key: str = ""


class TerraformRequest(BaseModel):
    request: str  # Natural-language description of what to create
    model: str = "groq"
    api_key: str = ""


class PlanRequest(BaseModel):
    hcl_config: str
    description: str


class ApplyRequest(BaseModel):
    execution_id: str
    approved: bool


class AgentRunRequest(BaseModel):
    anthropic_key: str
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_region: str = "us-east-1"
    issue_index: int = 0


class ApprovalRequest(BaseModel):
    approved: bool
    anthropic_key: str
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_region: str = "us-east-1"


# Create the FastAPI application instance.
# The 'title' appears in the auto-generated Swagger docs at /docs.
app = FastAPI(title="Agentic Cloud Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Only allow our frontend
    allow_methods=["GET", "POST"],  # POST added for /chat endpoint (Week 3)
    allow_headers=["*"],  # Allow any headers
)

_AWS_AUTH_CODES = {
    "InvalidClientTokenId",
    "AuthFailure",
    "AccessDenied",
    "UnauthorizedOperation",
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "AuthorizationError",
    "ExpiredTokenException",
}


def _api_error(exc: Exception) -> JSONResponse:
    name = type(exc).__name__
    msg = str(exc).lower()

    if isinstance(exc, NoCredentialsError):
        return JSONResponse(
            status_code=400,
            content={
                "error": "aws_credentials",
                "message": "Invalid AWS credentials — check your access key and secret",
            },
        )
    if isinstance(exc, BotoClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        if code in _AWS_AUTH_CODES:
            return JSONResponse(
                status_code=400,
                content={
                    "error": "aws_credentials",
                    "message": "Invalid AWS credentials — check your access key and secret",
                },
            )

    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or "timeout" in msg:
        return JSONResponse(
            status_code=503,
            content={
                "error": "timeout",
                "message": "Request timed out — AWS may be slow to respond",
            },
        )

    _LLM_HINTS = {
        "AuthenticationError",
        "PermissionDeniedError",
        "APIStatusError",
        "APIConnectionError",
        "RateLimitError",
        "APIError",
    }
    if (
        any(h in name for h in _LLM_HINTS)
        or "api key" in msg
        or "authentication" in msg
    ):
        return JSONResponse(
            status_code=503,
            content={
                "error": "llm_api",
                "message": "LLM API call failed — check your API key",
            },
        )

    return JSONResponse(
        status_code=500,
        content={
            "error": "internal",
            "message": str(exc),
        },
    )


@app.get("/health")
def health_check():
    """Return a simple status response to confirm the server is running."""
    return {"status": "ok", "version": "0.1.0"}


@app.get("/aws/ec2")
def get_ec2_instances():
    """
    Return a list of EC2 instances from the configured AWS account.

    Calls scan_ec2() which uses boto3 to query the AWS API.
    Always returns valid JSON — errors are caught inside scan_ec2()
    and returned as a structured response rather than a 500 error.
    """
    result = scan_ec2(region="us-east-1")
    return result


@app.get("/scan")
def full_scan(
    region: str = Query(default="us-east-1", description="AWS region to scan"),
):
    """
    Run a full infrastructure scan of the AWS account.

    Calls all five scanner functions in sequence and combines their results
    into a single JSON response. Each scanner has its own try/except, so a
    failure in one service (e.g. no IAM permissions) does not prevent the
    others from running.

    Query parameters:
      region — the AWS region to scan (default: us-east-1)
               Note: IAM and S3 are global and ignore this parameter.

    Returns a dict with keys: region, scan_status, ec2, s3, iam,
    security_groups, vpc. Each value is either a successful scan result
    or an error dict — never null, never a server crash.
    """
    try:
        return {
            "region": region,
            "scan_status": "complete",
            "ec2": scan_ec2(region),
            "s3": scan_s3(),
            "iam": scan_iam(),
            "security_groups": scan_security_groups(region),
            "vpc": scan_vpc(region),
        }
    except Exception as error:
        return _api_error(error)


@app.post("/chat")
async def chat(request: ChatRequest):
    """
    Send a message to an LLM with full AWS infrastructure context.

    On every request this endpoint:
      1. Runs a fresh scan of the AWS account (all 5 services)
      2. Injects the scan data into the LLM's system prompt
      3. Routes to the correct LLM based on request.model
      4. Returns the LLM's reply

    This means the LLM always has up-to-date infrastructure data —
    it cannot answer based on stale or cached information.

    Request body (JSON):
      message  (str)  — the user's question
      model    (str)  — "groq", "anthropic", or "ollama" (default: "groq")
      history  (list) — previous turns for conversation memory (default: [])
      api_key  (str)  — user-supplied key; overrides .env if non-empty

    Returns:
      {"reply": "...", "model": "..."}
      Never returns a 500 — all errors are returned as reply strings.
    """
    try:
        scan_data = {
            "ec2": scan_ec2(),
            "s3": scan_s3(),
            "iam": scan_iam(),
            "security_groups": scan_security_groups(),
            "vpc": scan_vpc(),
        }

        user_api_key = request.api_key.strip() if request.api_key.strip() else None

        if request.model == "groq":
            reply = await chat_with_groq(
                request.message, scan_data, request.history, user_api_key
            )
        elif request.model == "ollama":
            reply = await chat_with_ollama(
                request.message, scan_data, request.history, user_api_key
            )
        elif request.model == "anthropic":
            reply = await chat_with_anthropic(
                request.message, scan_data, request.history, user_api_key
            )
        else:
            reply = (
                f"Unknown model: '{request.model}'. Supported: groq, anthropic, ollama"
            )

        return {"reply": reply, "model": request.model}

    except Exception as e:
        return _api_error(e)


@app.get("/security")
async def security_analysis(
    region: str = Query(default="us-east-1", description="AWS region to scan"),
    model: str = Query(
        default="groq", description="LLM model for summary: groq, anthropic, ollama"
    ),
    api_key: str = Query(default="", description="Optional API key override"),
):
    """
    Run a full security analysis on the AWS account.

    This endpoint:
      1. Calls all 5 AWS scanners to get fresh infrastructure data
      2. Applies all 7 security rules from security_analyzer.py
      3. Calls the selected LLM to generate a plain-English summary
      4. Returns structured findings sorted HIGH → MEDIUM → LOW,
         plus severity counts and the LLM summary

    Query parameters:
      region  — AWS region to scan (default: us-east-1)
      model   — LLM to use for summary: groq, anthropic, ollama
      api_key — Optional key override; falls back to .env if empty

    Returns a dict with:
      status, total_findings, severity_counts, findings, llm_summary,
      region, model_used

    Never returns a 500 — all errors are caught and returned as JSON.
    """
    try:
        scan_data = {
            "ec2": scan_ec2(region),
            "s3": scan_s3(),
            "iam": scan_iam(),
            "security_groups": scan_security_groups(region),
            "vpc": scan_vpc(region),
        }

        findings = run_security_analysis(scan_data)

        resolved_key = api_key.strip() if api_key.strip() else None
        summary = await get_security_summary(findings, model, resolved_key)

        counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
        for f in findings:
            sev = f.get("severity", "LOW")
            counts[sev] = counts.get(sev, 0) + 1

        return {
            "status": "complete",
            "total_findings": len(findings),
            "severity_counts": counts,
            "findings": findings,
            "llm_summary": summary,
            "region": region,
            "model_used": model,
        }

    except Exception as e:
        return _api_error(e)


@app.get("/cost")
async def cost_analysis(
    model: str = Query(
        default="groq", description="LLM model: groq, anthropic, ollama"
    ),
    api_key: str = Query(default="", description="Optional API key override"),
):
    """
    Retrieve AWS cost data with LLM-generated optimisation insights.

    This endpoint:
      1. Fetches current month total spend from AWS Cost Explorer
      2. Fetches last 3 months of monthly spend for trend analysis
      3. Fetches spend broken down by AWS service (current month)
      4. Detects cost anomalies (20%+ increase vs previous month)
      5. Calls the selected LLM to generate a plain-English summary

    Requires the IAM permission: ce:GetCostAndUsage
    If that permission is missing, all cost amounts return as 0.0
    and the LLM summary explains what is needed to enable Cost Explorer.

    Query parameters:
      model   — LLM to use for the summary: groq, anthropic, ollama
      api_key — Optional key override; falls back to .env if empty

    Returns a dict with:
      status, current_month, monthly_trend, by_service,
      anomaly, llm_summary, error

    Always returns HTTP 200 — Cost Explorer failures are surfaced
    as structured JSON, not server errors.
    """
    try:
        current_month = get_current_month_cost()
        monthly_trend = get_monthly_trend(months=3)
        by_service = get_cost_by_service()

        anomaly = detect_cost_anomaly(monthly_trend)

        resolved_key = api_key.strip() if api_key.strip() else None
        llm_summary = await get_cost_insights_llm(
            current_month,
            monthly_trend,
            by_service,
            anomaly,
            model,
            resolved_key,
        )

        return {
            "status": "complete",
            "current_month": current_month,
            "monthly_trend": monthly_trend,
            "by_service": by_service,
            "anomaly": anomaly,
            "llm_summary": llm_summary,
            "error": None,
        }

    except Exception as e:
        return _api_error(e)


@app.post("/terraform/generate")
async def terraform_generate(request: TerraformRequest):
    """
    Generate Terraform HCL from a plain-English request using LLM tool use.

    This endpoint:
      1. Routes to the correct LLM (Anthropic tool_choice or Groq JSON-mode)
      2. Receives structured output: hcl, resource_type, description
      3. Validates the HCL by running terraform init + terraform validate
         in a temporary directory (nothing touches the real filesystem)
      4. Returns the HCL, validation result, and metadata

    Request body (JSON):
      request  (str) — e.g. "create an EC2 t3.micro with a security group"
      model    (str) — "groq" or "anthropic" (default: "groq")
      api_key  (str) — optional key override; falls back to .env if empty

    Returns:
      {
        "hcl":           str,
        "resource_type": str,
        "description":   str,
        "validation":    {"valid": bool, "message": str},
        "model_used":    str,
        "error":         str | null,
      }

    Always returns HTTP 200 — all errors are surfaced as structured JSON.
    """
    try:
        resolved_key = request.api_key.strip() if request.api_key.strip() else ""
        result = await generate_terraform(request.request, request.model, resolved_key)
        result["model_used"] = request.model
        return result
    except Exception as e:
        return _api_error(e)


@app.post("/terraform/plan")
async def terraform_plan(request: PlanRequest):
    """
    Run terraform plan on the provided HCL config.

    Creates a persistent working directory and saves the tfplan binary
    so that /terraform/apply can use it later.

    This endpoint is READ-ONLY — it never modifies AWS resources.
    The user must review the plan output and explicitly call /terraform/apply
    with approved=True to make any changes.

    Request body:
      hcl_config  (str) — complete Terraform HCL
      description (str) — user's original natural-language request

    Returns:
      status, execution_id, plan_output, plan_success,
      resources_to_add/change/destroy, description

    Always returns HTTP 200 — errors are surfaced as structured JSON.
    """
    try:
        execution_id = create_execution_id()
        result = run_terraform_plan(request.hcl_config, execution_id)

        status = "awaiting_approval" if result["success"] else "plan_failed"

        log_execution(
            {
                "execution_id": execution_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "description": request.description,
                "plan_output": result["plan_output"],
                "resources_to_add": result["resources_to_add"],
                "resources_to_change": result["resources_to_change"],
                "resources_to_destroy": result["resources_to_destroy"],
                "approved": None,
                "apply_output": None,
                "status": status,
                "resources_applied": [],
            }
        )

        return {
            "status": status,
            "execution_id": execution_id,
            "plan_output": result["plan_output"],
            "plan_success": result["success"],
            "resources_to_add": result["resources_to_add"],
            "resources_to_change": result["resources_to_change"],
            "resources_to_destroy": result["resources_to_destroy"],
            "description": request.description,
        }

    except Exception as e:
        return _api_error(e)


@app.post("/terraform/apply")
async def terraform_apply(request: ApplyRequest):
    """
    Apply previously planned Terraform changes.

    REQUIRES approved=True — will immediately reject and log if False.
    Uses the saved tfplan file (not a newly computed plan) so the user
    gets exactly what they reviewed.

    WHY approved MUST BE IN THE REQUEST BODY:
      The approval decision comes from the user's explicit action in the
      UI (clicking "Approve & Apply"). Making it a required field prevents
      accidental application and provides a clear audit trail.

    Request body:
      execution_id (str)  — from the /terraform/plan response
      approved     (bool) — must be True to apply; False records rejection

    Returns (approved=True):
      status, execution_id, apply_output, apply_success, resources_applied

    Returns (approved=False):
      status="rejected", execution_id, message

    Always returns HTTP 200.
    """
    try:
        if not request.approved:
            log_execution_update(
                request.execution_id,
                {
                    "approved": False,
                    "status": "rejected",
                    "apply_output": "User rejected the plan. No changes made.",
                },
            )
            return {
                "status": "rejected",
                "execution_id": request.execution_id,
                "message": "Execution rejected by user. No changes made.",
            }

        result = run_terraform_apply(request.execution_id)
        final_status = "complete" if result["success"] else "failed"

        log_execution_update(
            request.execution_id,
            {
                "approved": True,
                "apply_output": result["apply_output"],
                "status": final_status,
                "resources_applied": result["resources_applied"],
            },
        )

        return {
            "status": final_status,
            "execution_id": request.execution_id,
            "apply_output": result["apply_output"],
            "apply_success": result["success"],
            "resources_applied": result["resources_applied"],
        }

    except Exception as e:
        return _api_error(e)


@app.get("/terraform/executions")
def terraform_executions():
    """Return the full execution history from the persistent log file."""
    history = get_execution_history()
    return {"executions": history, "total": len(history)}


@app.post("/agent/run")
async def agent_run(request: AgentRunRequest):
    """
    Run the full agentic security remediation loop.

    Scans live AWS state, identifies the highest-priority security issue,
    calls claude-opus-4-5 in a tool-use loop to generate HCL, plan it,
    and produce a plain-English approval summary.

    NEVER applies changes — returns plan + summary for human review.

    Request body:
      anthropic_key         — Anthropic API key
      aws_access_key_id     — AWS access key
      aws_secret_access_key — AWS secret key
      aws_region            — AWS region (default: us-east-1)
      issue_index           — Which finding to fix; 0 = highest priority

    Returns:
      {status: "awaiting_approval"|"no_issues", execution_id, issue,
       hcl, plan_output, summary, plan_success}
    """
    credentials = {
        "anthropic_api_key": request.anthropic_key,
        "aws_access_key_id": request.aws_access_key_id,
        "aws_secret_access_key": request.aws_secret_access_key,
        "region": request.aws_region,
    }
    try:
        result = await agent_service.run_security_agent(
            credentials, request.issue_index
        )
        return result
    except Exception as e:
        return _api_error(e)


@app.post("/agent/approve/{execution_id}")
async def agent_approve(execution_id: str, request: ApprovalRequest):
    """
    Human approval gate for a previously planned agent execution.

    If approved=False: marks the execution as rejected and returns immediately.
    If approved=True:  calls terraform apply on the saved plan and returns
                       the apply output.

    Path parameter:
      execution_id — from the /agent/run response

    Request body:
      approved              — True to apply, False to reject
      anthropic_key         — Anthropic API key (passed through to apply)
      aws_access_key_id     — AWS access key
      aws_secret_access_key — AWS secret key
      aws_region            — AWS region (default: us-east-1)

    Returns:
      approved=False: {status: "rejected"}
      approved=True:  {status: "complete"|"failed", output: str}
    """
    if not request.approved:
        log_execution_update(
            execution_id,
            {
                "approved": False,
                "status": "rejected",
                "apply_output": "User rejected the agent plan. No changes made.",
            },
        )
        return {"status": "rejected"}

    credentials = {
        "anthropic_api_key": request.anthropic_key,
        "aws_access_key_id": request.aws_access_key_id,
        "aws_secret_access_key": request.aws_secret_access_key,
        "region": request.aws_region,
    }
    try:
        result = await agent_service.approve_and_apply(execution_id, credentials)
        return result
    except Exception as e:
        return _api_error(e)


@app.get("/agent/status/{execution_id}")
def agent_status(execution_id: str):
    """
    Fetch the current state of a specific agent execution.

    Path parameter:
      execution_id — from the /agent/run response

    Returns the full execution record, or 404 if not found.
    """
    history = get_execution_history()
    for entry in history:
        if entry.get("execution_id") == execution_id:
            return entry
    raise HTTPException(
        status_code=404, detail=f"Execution '{execution_id}' not found."
    )


# =============================================================================
# RAG endpoints — knowledge base query and document management
# =============================================================================


class RagQueryRequest(BaseModel):
    question: str
    resource_type: Optional[str] = None
    n_results: int = 3
    groq_key: Optional[str] = None
    anthropic_key: Optional[str] = None
    model_provider: str = "groq"


class RagTextIngestRequest(BaseModel):
    doc_id: str
    text: str
    resource_type: str = "general"
    source: str = "user-input"
    title: str = ""


@app.post("/rag/query")
async def rag_query(request: RagQueryRequest):
    """
    Retrieve relevant knowledge chunks and answer the question with
    an LLM that has been grounded by the retrieved context.

    Step 1: query_knowledge_base() retrieves the top matching chunks
            from ChromaDB and builds an augmented prompt.
    Step 2: The augmented prompt (not the raw question) is sent to the
            selected LLM so it can reason from retrieved source material.
    Step 3: Returns the answer, the sources that were consulted, and
            the raw chunks for transparency.

    Request body:
      question      (str) — the security question to answer
      resource_type (str) — optional filter: s3, ec2, iam, vpc, terraform
      n_results     (int) — number of chunks to retrieve (default 3)
      groq_key      (str) — optional Groq API key override
      anthropic_key (str) — optional Anthropic API key override
      model_provider(str) — "groq", "anthropic", or "ollama" (default: groq)

    Returns:
      question, answer, sources, chunks_used, raw_chunks
    """
    try:
        rag_result = query_knowledge_base(
            query=request.question,
            n_results=request.n_results,
            resource_filter=request.resource_type,
        )

        augmented_prompt = rag_result["augmented_prompt"]

        # Route to the correct LLM using the augmented prompt as the message.
        # scan_data is empty ({}) because this endpoint provides context via
        # RAG rather than a live AWS scan.
        if request.model_provider == "anthropic":
            resolved_key = request.anthropic_key.strip() if request.anthropic_key else None
            answer = await chat_with_anthropic(
                message=augmented_prompt,
                scan_data={},
                history=[],
                api_key=resolved_key,
            )
        elif request.model_provider == "ollama":
            answer = await chat_with_ollama(
                message=augmented_prompt,
                scan_data={},
                history=[],
                api_key=None,
            )
        else:  # default: groq
            resolved_key = request.groq_key.strip() if request.groq_key else None
            answer = await chat_with_groq(
                message=augmented_prompt,
                scan_data={},
                history=[],
                api_key=resolved_key,
            )

        return {
            "question": request.question,
            "answer": answer,
            "sources": rag_result["sources"],
            "chunks_used": rag_result["chunks_used"],
            "raw_chunks": rag_result["raw_chunks"],
        }

    except Exception as e:
        return _api_error(e)


@app.post("/rag/documents/upload")
async def rag_upload_document(
    file: UploadFile = File(...),
    doc_id: str = Form(...),
    resource_type: str = Form(default="general"),
    source: str = Form(default="user-upload"),
):
    """
    Upload a file (PDF or plain text) and add it to the knowledge base.

    Accepts multipart/form-data with the file plus doc_id and optional
    metadata fields. PDFs are parsed with PyPDF2; all other files are
    decoded as UTF-8 text.

    Form fields:
      file          — the file to upload (.pdf or .txt)
      doc_id        — unique identifier for this document (used for upsert/delete)
      resource_type — aws service tag: s3, ec2, iam, vpc, terraform, general
      source        — provenance label (default: "user-upload")

    Returns:
      status, doc_id, filename, chunks_added
    """
    try:
        file_bytes = await file.read()
        filename = file.filename or ""

        if filename.lower().endswith(".pdf"):
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
            pages = [
                page.extract_text() or ""
                for page in pdf_reader.pages
            ]
            text = "\n\n".join(pages)
        else:
            text = file_bytes.decode("utf-8", errors="replace")

        text = text.strip()
        if not text:
            return JSONResponse(
                status_code=400,
                content={
                    "error": "empty_document",
                    "message": (
                        "No text could be extracted from the uploaded file. "
                        "Check that the PDF contains selectable text (not scanned images)."
                    ),
                },
            )

        metadata = {
            "source": source,
            "resource_type": resource_type,
            "filename": filename,
            "upload_type": "user-upload",
        }

        result = knowledge_base.add_document(
            doc_id=doc_id,
            text=text,
            metadata=metadata,
        )

        return {
            "status": "success",
            "doc_id": doc_id,
            "filename": filename,
            "chunks_added": result["chunks_added"],
        }

    except Exception as e:
        return _api_error(e)


@app.post("/rag/documents/text")
async def rag_ingest_text(request: RagTextIngestRequest):
    """
    Add a plain-text document to the knowledge base directly from JSON.

    Useful for programmatic ingestion of runbooks, architecture notes, or
    any text content that does not need file upload.

    Request body:
      doc_id        (str) — unique identifier for this document
      text          (str) — the document content to chunk and embed
      resource_type (str) — aws service tag (default: general)
      source        (str) — provenance label (default: user-input)
      title         (str) — optional human-readable title for display

    Returns:
      status, doc_id, chunks_added
    """
    try:
        metadata = {
            "source": request.source,
            "resource_type": request.resource_type,
            "title": request.title,
            "upload_type": "user-input",
        }

        result = knowledge_base.add_document(
            doc_id=request.doc_id,
            text=request.text,
            metadata=metadata,
        )

        return {
            "status": "success",
            "doc_id": request.doc_id,
            "chunks_added": result["chunks_added"],
        }

    except Exception as e:
        return _api_error(e)


@app.get("/rag/documents")
def rag_list_documents():
    """
    List all documents currently stored in the knowledge base.

    Returns each document's doc_id, source, resource_type, and chunk count,
    plus the total number of chunks across all documents.

    Returns:
      documents, total_documents, total_chunks
    """
    try:
        documents = knowledge_base.list_documents()
        return {
            "documents": documents,
            "total_documents": len(documents),
            "total_chunks": knowledge_base.get_document_count(),
        }
    except Exception as e:
        return _api_error(e)


@app.delete("/rag/documents/{doc_id}")
def rag_delete_document(doc_id: str):
    """
    Delete a document and all its chunks from the knowledge base.

    Path parameter:
      doc_id — the identifier used when the document was added

    Returns:
      status, deleted_chunks, doc_id
    """
    try:
        result = knowledge_base.delete_document(doc_id)
        return {
            "status": "deleted",
            "deleted_chunks": result["deleted_chunks"],
            "doc_id": doc_id,
        }
    except Exception as e:
        return _api_error(e)
