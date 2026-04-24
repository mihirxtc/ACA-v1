# Tool Use API vs MCP — Full Execution Deep Dive

This document traces every step of both architectures from trigger to result,
using the actual code in this repository. Every function name, line number,
and data structure referenced here exists verbatim in the codebase.

---

## Part 1 — Version 1: Tool Use API

### 1.1 How it starts — the HTTP trigger

Everything begins with an HTTP POST from the React frontend:

```
POST http://localhost:8000/agent/run
Content-Type: application/json

{
  "anthropic_key": "sk-ant-...",
  "aws_access_key_id": "AKIA...",
  "aws_secret_access_key": "...",
  "aws_region": "us-east-1",
  "issue_index": 0
}
```

FastAPI in `main.py:597` receives this, validates it against
`AgentRunRequest` (a Pydantic model), builds a `credentials` dict, and
calls:

```python
# main.py:619-631
credentials = {
    "anthropic_api_key": request.anthropic_key,
    "aws_access_key_id": request.aws_access_key_id,
    "aws_secret_access_key": request.aws_secret_access_key,
    "region": request.aws_region,
}
result = await agent_service.run_security_agent(credentials, request.issue_index)
```

The credentials dict is a plain Python dict passed as a function argument.
It travels through every subsequent call.

---

### 1.2 The AWS scan phase (agent_service.py:74-82)

Before a single LLM call is made, the agent scans live AWS state:

```python
# agent_service.py:74-82
region = credentials.get("region", "us-east-1")

scan_data = {
    "ec2":             scan_ec2(region, credentials=credentials),
    "s3":              scan_s3(credentials=credentials),
    "iam":             scan_iam(credentials=credentials),
    "security_groups": scan_security_groups(region, credentials=credentials),
    "vpc":             scan_vpc(region, credentials=credentials),
}
```

Each of these calls `get_aws_session(credentials)` inside `aws_scanner.py:5`
which builds a `boto3.Session` with the explicit keys from the dict:

```python
# aws_scanner.py:5-22
def get_aws_session(credentials: dict) -> boto3.Session:
    return boto3.Session(
        aws_access_key_id=credentials.get("aws_access_key_id"),
        aws_secret_access_key=credentials.get("aws_secret_access_key"),
        region_name=credentials.get("aws_region", credentials.get("region", "us-east-1")),
    )
```

This is a **per-request boto3 session** — every HTTP request gets its own
AWS session with its own credentials. Five separate AWS API calls happen
synchronously before the LLM is involved at all.

---

### 1.3 Security analysis — pure Python, no LLM

```python
# agent_service.py:87-90
findings = run_security_analysis(scan_data)
if not findings:
    return {"status": "no_issues"}
```

`run_security_analysis` in `security_analyzer.py:494` applies 7 rule
functions in sequence and sorts results. This entire step has zero LLM
involvement — it is deterministic Python logic running against the scan data.

---

### 1.4 Tool registration — hardcoded dicts

Before any API call, the tools available to the LLM are defined as plain
Python dicts in `terraform_service.py`:

```python
# terraform_service.py:11-85

TERRAFORM_TOOL = {
    "name": "generate_terraform",
    "description": "Generate complete, valid Terraform HCL for an AWS resource.",
    "input_schema": {
        "type": "object",
        "properties": {
            "hcl":           {"type": "string", "description": "Complete Terraform HCL..."},
            "resource_type": {"type": "string", "description": "Primary AWS resource type..."},
            "description":   {"type": "string", "description": "One-sentence description..."},
        },
        "required": ["hcl", "resource_type", "description"],
    },
}

RUN_PLAN_TOOL = {
    "name": "run_terraform_plan",
    "description": "Write the generated HCL to a temp directory and run terraform plan...",
    "input_schema": {
        "type": "object",
        "properties": {
            "hcl_content":          {"type": "string", ...},
            "resource_description": {"type": "string", ...},
        },
        "required": ["hcl_content"],
    },
}

SUMMARISE_PLAN_TOOL = {
    "name": "summarise_plan_for_human",
    "description": "Take raw terraform plan output and produce a clear, plain-English summary...",
    "input_schema": {
        "type": "object",
        "properties": {
            "plan_output":       {"type": "string", ...},
            "issue_being_fixed": {"type": "string", ...},
            "risk_level":        {"type": "string", "enum": ["low", "medium", "high"], ...},
        },
        "required": ["plan_output", "issue_being_fixed"],
    },
}

TOOLS = [TERRAFORM_TOOL, RUN_PLAN_TOOL, SUMMARISE_PLAN_TOOL, RAG_TOOL_DEFINITION]
```

This list is **static** — assembled at module import time. Adding a new
tool requires editing this file. The schema (parameter types, descriptions,
required fields) is written by hand and has no connection to the Python
function that will eventually execute the tool — the two can silently
diverge.

---

### 1.5 Building the initial message

```python
# agent_service.py:101-111
findings_text = json.dumps(findings, indent=2, default=str)
target_text   = json.dumps(target_issue, indent=2, default=str)

initial_message = (
    f"Here are the AWS security findings from a live scan:\n\n"
    f"```json\n{findings_text}\n```\n\n"
    f"Please fix the following highest-priority issue (index {target_index}):\n\n"
    f"```json\n{target_text}\n```\n\n"
    f"Follow the four-step process: generate_terraform → run_terraform_plan "
    f"→ summarise_plan_for_human."
)
```

The entire findings JSON (potentially hundreds of lines) is embedded as a
string inside the first user message. Every subsequent API call in the loop
carries this full context in the `messages` array — it is never truncated or
summarised between iterations.

---

### 1.6 SDK client initialisation

```python
# agent_service.py:116-117
api_key = credentials.get("anthropic_api_key") or os.getenv("ANTHROPIC_API_KEY", "")
client  = anthropic.Anthropic(api_key=api_key)
```

A new `anthropic.Anthropic` SDK client is instantiated on every call to
`run_security_agent`. The API key comes first from the request's credentials
dict, then falls back to the environment variable. There is no connection
pooling or client reuse across requests.

---

### 1.7 The agentic loop — full annotated walkthrough

```python
# agent_service.py:119-190

messages  = [{"role": "user", "content": initial_message}]
collected_hcl          = ""
collected_plan_output  = ""
collected_summary      = ""
iteration              = 0

while iteration < MAX_ITERATIONS:          # MAX_ITERATIONS = 6 (line 46)
    iteration += 1

    # ── STEP A: call Anthropic ─────────────────────────────────────────────
    response = client.messages.create(
        model      = "claude-opus-4-5",
        max_tokens = 4096,
        system     = SYSTEM_PROMPT,        # from agent_service.py:27
        tools      = TOOLS,                # the 4 dicts from terraform_service.py
        messages   = messages,             # grows with every iteration
    )
    # The full TOOLS list is serialised to JSON and sent to Anthropic
    # on EVERY iteration — even if the model already knows the schemas.

    # ── STEP B: append assistant response to conversation ─────────────────
    messages.append({"role": "assistant", "content": response.content})
    # response.content is a list of ContentBlock objects (TextBlock or ToolUseBlock)

    # ── STEP C: check stop reason ─────────────────────────────────────────
    if response.stop_reason == "end_turn":
        break   # model finished — no more tool calls requested
    if response.stop_reason != "tool_use":
        break   # unexpected stop — safety exit

    # ── STEP D: collect all tool_use blocks ───────────────────────────────
    tool_results = []

    for block in response.content:
        if block.type != "tool_use":
            continue

        tool_name  = block.name    # e.g. "generate_terraform"
        tool_input = block.input   # dict, e.g. {"hcl": "...", "resource_type": "..."}
        tool_id    = block.id      # e.g. "toolu_01XYZ..."

        # ── STEP E: dispatch ──────────────────────────────────────────────
        result = dispatch_tool(tool_name, tool_input)
        # dispatch_tool is in terraform_service.py:491

        # ── STEP F: collect artefacts ─────────────────────────────────────
        if tool_name == "generate_terraform":
            collected_hcl = result.get("hcl", "")
        elif tool_name == "run_terraform_plan":
            collected_plan_output = result.get("plan_output", "")
        elif tool_name == "summarise_plan_for_human":
            collected_summary = result.get("summary", "")

        # ── STEP G: format tool result for next API call ──────────────────
        tool_results.append({
            "type":        "tool_result",
            "tool_use_id": tool_id,
            "content":     json.dumps(result, default=str),
            # result is always serialised to a JSON string — not a nested object
        })

    if not tool_results:
        break

    # ── STEP H: append all results as a single user turn ──────────────────
    messages.append({"role": "user", "content": tool_results})
    # All tool results from one response go in ONE user message.
    # This is the Anthropic-required format for multi-tool responses.
```

**What the messages array looks like after one complete tool call:**

```python
messages = [
    # Turn 0 — initial prompt (user)
    {"role": "user",      "content": "Here are the AWS findings...\nPlease fix..."},

    # Turn 1 — model requests tool use (assistant)
    {"role": "assistant", "content": [
        TextBlock(type="text", text="I'll generate the Terraform HCL..."),
        ToolUseBlock(
            type  = "tool_use",
            id    = "toolu_01XYZ",
            name  = "generate_terraform",
            input = {"hcl": "terraform {...}", "resource_type": "aws_security_group", ...}
        )
    ]},

    # Turn 2 — tool result (user)
    {"role": "user", "content": [
        {
            "type":        "tool_result",
            "tool_use_id": "toolu_01XYZ",
            "content":     '{"hcl": "terraform {...}", "resource_type": "aws_security_group", ...}'
        }
    ]},

    # Turn 3 — model requests next tool (assistant)
    {"role": "assistant", "content": [
        ToolUseBlock(name="run_terraform_plan", input={"hcl_content": "..."}, ...)
    ]},
    ...
]
```

The messages list grows by 2 entries per iteration. By iteration 3, the
conversation history being sent to Anthropic is substantial.

---

### 1.8 The dispatch table — terraform_service.py:491

```python
def dispatch_tool(tool_name: str, tool_input: dict) -> dict:
    if tool_name == "generate_terraform":
        return handle_generate_terraform(**tool_input)
        # tool_input is unpacked as kwargs:
        # handle_generate_terraform(hcl="...", resource_type="...", description="...")

    elif tool_name == "run_terraform_plan":
        return handle_run_terraform_plan(**tool_input)
        # handle_run_terraform_plan(hcl_content="...", resource_description="...")

    elif tool_name == "summarise_plan_for_human":
        return handle_summarise_plan(**tool_input)
        # handle_summarise_plan(plan_output="...", issue_being_fixed="...", risk_level="...")

    elif tool_name == "query_security_knowledge_base":
        return handle_rag_tool_call(tool_input)
        # note: NOT unpacked — receives the full dict

    else:
        return {"error": f"Unknown tool: {tool_name}"}
        # silently returns an error; the LLM will see this in its tool_result
```

The dispatch table is a manually maintained if/elif chain. If a new tool is
added to `TOOLS` but not here, the LLM calls it and gets
`{"error": "Unknown tool: ..."}` back — no exception, no warning.

---

### 1.9 What each handler actually does

**`handle_generate_terraform` (terraform_service.py:275)**
A pure passthrough. The LLM has already generated the HCL inside its
`tool_use` block. This function simply returns what was in `tool_input`:

```python
def handle_generate_terraform(hcl, resource_type="unknown", description="") -> dict:
    return {"hcl": hcl, "resource_type": resource_type, "description": description}
```

No computation. The LLM is the generator; this handler is just the
acknowledgement.

**`handle_run_terraform_plan` (terraform_service.py:296)**
Creates a persistent temp directory with `tempfile.mkdtemp(prefix="aca_plan_")`,
writes `main.tf`, then runs two subprocesses:

```python
init = subprocess.run(
    ["terraform", "init", "-backend=false", "-no-color"],
    cwd=working_dir, capture_output=True, text=True, timeout=120,
)
plan = subprocess.run(
    ["terraform", "plan", "-no-color"],
    cwd=working_dir, capture_output=True, text=True, timeout=180,
)
```

The directory is **not deleted** — it persists on disk so `approve_and_apply`
can find the `tfplan` binary later.

**`handle_summarise_plan` (terraform_service.py:381)**
Pure Python. Parses the terraform plan output with a regex:

```python
plan_match = re.search(
    r"Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy",
    plan_output, re.IGNORECASE,
)
```

Builds a human-readable summary string. No subprocess, no AWS call, no LLM.

---

### 1.10 After the loop — execution service

After `MAX_ITERATIONS` or `end_turn`, execution returns to `agent_service.py:196`:

```python
# agent_service.py:196-223
execution_id = create_execution_id()
# format: "exec_20260422_015000_a1b2c3d4"

if collected_hcl:
    plan_result = run_terraform_plan(collected_hcl, execution_id)
    # This is execution_service.run_terraform_plan — different from
    # terraform_service.handle_run_terraform_plan.
    # It writes to terraform_workdirs/{execution_id}/main.tf
    # and saves a binary tfplan file for apply later.

log_entry = {
    "execution_id":   execution_id,
    "timestamp":      datetime.now(timezone.utc).isoformat(),
    "status":         "awaiting_approval",
    "issue":          target_issue,
    "hcl":            collected_hcl,
    "plan_output":    collected_plan_output,
    "summary":        collected_summary,
    "plan_success":   plan_result.get("success", False),
    "iterations":     iteration,
    "approved":       None,
    "apply_output":   None,
}
log_execution(log_entry)
# appends to execution_log.json — a flat JSON array on disk
```

The function returns to FastAPI with:
```python
{
    "status":       "awaiting_approval",
    "execution_id": "exec_20260422_015000_a1b2c3d4",
    "issue":        {...},
    "hcl":          "terraform { ... }",
    "plan_output":  "Plan: 1 to add, 0 to change, 0 to destroy.",
    "summary":      "Issue being fixed: ...\n\nWhat will happen: ...",
    "plan_success": True,
}
```

FastAPI sends this JSON back to the React frontend. The frontend renders
the summary and shows an "Approve" button.

---

### 1.11 The human approval gate

The user reads the summary and clicks Approve. The frontend POSTs:

```
POST http://localhost:8000/agent/approve/exec_20260422_015000_a1b2c3d4
{
  "approved": true,
  "anthropic_key": "sk-ant-...",
  "aws_access_key_id": "AKIA...",
  ...
}
```

`main.py:634` receives this. If `approved=False` it logs the rejection and
returns immediately. If `approved=True`:

```python
# agent_service.py:248-275
async def approve_and_apply(execution_id, credentials) -> dict:
    log_execution_update(execution_id, {"status": "applying", "approved": True})

    apply_result = run_terraform_apply(execution_id)
    # execution_service.py:138
    # finds terraform_workdirs/{execution_id}/tfplan
    # runs: subprocess.run(["terraform", "apply", "-auto-approve", "-no-color", "tfplan"])

    log_execution_update(execution_id, {
        "status":       "complete" if success else "failed",
        "apply_output": apply_output,
    })
    return {"status": "complete"/"failed", "output": apply_output}
```

`-auto-approve` is used because the human already approved via the HTTP
gate — it skips terraform's own interactive confirmation prompt.

---

### 1.12 Full Tool Use API execution timeline

```
HTTP POST /agent/run
  │
  ├─ 1. scan_ec2()          → boto3 → AWS EC2 API
  ├─ 2. scan_s3()           → boto3 → AWS S3 API
  ├─ 3. scan_iam()          → boto3 → AWS IAM API
  ├─ 4. scan_security_groups() → boto3 → AWS EC2 API
  ├─ 5. scan_vpc()          → boto3 → AWS EC2 API
  │
  ├─ 6. run_security_analysis(scan_data)  [pure Python]
  │
  ├─ 7. client.messages.create(tools=TOOLS, messages=[initial])
  │      → HTTPS → Anthropic API
  │      ← response: stop_reason="tool_use", tool_use: generate_terraform
  │
  ├─ 8. dispatch_tool("generate_terraform", {...})
  │      → handle_generate_terraform()  [pure passthrough]
  │
  ├─ 9. client.messages.create(tools=TOOLS, messages=[..., tool_result])
  │      → HTTPS → Anthropic API
  │      ← response: stop_reason="tool_use", tool_use: run_terraform_plan
  │
  ├─ 10. dispatch_tool("run_terraform_plan", {"hcl_content": "..."})
  │       → handle_run_terraform_plan()
  │           → subprocess: terraform init  [downloads AWS provider ~50MB]
  │           → subprocess: terraform plan  [connects to AWS to check state]
  │
  ├─ 11. client.messages.create(tools=TOOLS, messages=[..., tool_result])
  │       → HTTPS → Anthropic API
  │       ← response: stop_reason="tool_use", tool_use: summarise_plan_for_human
  │
  ├─ 12. dispatch_tool("summarise_plan_for_human", {...})
  │       → handle_summarise_plan()  [pure Python regex parsing]
  │
  ├─ 13. client.messages.create(tools=TOOLS, messages=[..., tool_result])
  │       → HTTPS → Anthropic API
  │       ← response: stop_reason="end_turn"
  │       [loop exits]
  │
  ├─ 14. run_terraform_plan(collected_hcl, execution_id)
  │       → writes terraform_workdirs/{id}/main.tf
  │       → subprocess: terraform init
  │       → subprocess: terraform plan -out=tfplan  [saves binary plan]
  │
  ├─ 15. log_execution(entry) → writes execution_log.json
  │
  └─ HTTP 200 → {"status": "awaiting_approval", ...}

[user reads summary, clicks Approve]

HTTP POST /agent/approve/{execution_id}
  │
  ├─ 16. log_execution_update(id, {approved: True, status: "applying"})
  ├─ 17. run_terraform_apply(execution_id)
  │       → subprocess: terraform apply -auto-approve tfplan
  │           [actually creates/modifies AWS resources]
  ├─ 18. log_execution_update(id, {status: "complete", apply_output: "..."})
  └─ HTTP 200 → {"status": "complete", "output": "..."}
```

**Total Anthropic API calls for a typical run: 3–4**
**Total subprocess calls: 4–6** (init×2, plan×2, apply×1)
**Total AWS API calls: 5** (one per scanner) + however many terraform plan makes

---

## Part 2 — Version 2: MCP

### 2.1 How the server starts

The MCP server is a long-running process launched by a client — not by
a user HTTP request. When Claude Desktop connects, it runs:

```
python /path/to/backend/mcp_server.py
```

The first thing `mcp_server.py` does on import:

```python
# mcp_server.py:7-14
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
# ^ adds backend/ to sys.path so "from services.aws_scanner import..."  works

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
# ^ reads backend/.env into os.environ immediately at startup
# credentials are loaded ONCE, at process start, for the entire lifetime
```

Then the `FastMCP` instance is created:

```python
# mcp_server.py:16-30
from fastmcp import FastMCP
mcp = FastMCP("agentic-cloud-assistant")
```

All `@mcp.tool()` and `@mcp.resource()` decorated functions are registered
into `mcp`'s internal registry as the module loads. There is no explicit
registration call — Python's decorator execution at import time handles it.

---

### 2.2 Tool registration — decorator-based, schema-derived

In Version 1, a tool's schema was a hand-written dict that had no
programmatic connection to the function it described. In Version 2:

```python
# mcp_server.py:44-73
@mcp.tool()
def scan_ec2_instances(region: str = "us-east-1") -> dict:
    """Scan all EC2 instances in the specified AWS region.
    ...
    """
    return scan_ec2(region=region)
```

FastMCP inspects this at decoration time using Python's `inspect` module:
- **Tool name**: derived from `scan_ec2_instances` (function name)
- **Parameter schema**: derived from `region: str = "us-east-1"` (type
  annotation + default value → JSON Schema `{"type": "string", "default": "us-east-1"}`)
- **Description**: derived from the docstring

The generated JSON Schema sent to any MCP client looks like:

```json
{
  "name": "scan_ec2_instances",
  "description": "Scan all EC2 instances in the specified AWS region.\n\nUses ambient AWS credentials...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "region": {
        "type": "string",
        "default": "us-east-1",
        "description": "AWS region identifier..."
      }
    }
  }
}
```

This schema is **always in sync** with the function — renaming a parameter
in the function signature automatically updates the schema the client sees.

---

### 2.3 The MCP handshake — what happens over stdio

The MCP protocol runs over stdio (stdin/stdout). The client and server
exchange JSON-RPC 2.0 messages. Here is the exact sequence when Claude
Desktop starts the server:

```
CLIENT → SERVER  (JSON-RPC request)
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {"roots": {"listChanged": true}},
    "clientInfo": {"name": "Claude Desktop", "version": "..."}
  }
}

SERVER → CLIENT  (JSON-RPC response)
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {"listChanged": false},
      "resources": {"subscribe": false, "listChanged": false}
    },
    "serverInfo": {"name": "agentic-cloud-assistant", "version": "3.2.4"}
  }
}

CLIENT → SERVER
{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}

SERVER → CLIENT
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {"name": "health_check",              "description": "...", "inputSchema": {...}},
      {"name": "scan_ec2_instances",        "description": "...", "inputSchema": {...}},
      {"name": "scan_s3_buckets",           "description": "...", "inputSchema": {...}},
      {"name": "analyse_security_findings", "description": "...", "inputSchema": {...}},
      {"name": "estimate_costs",            "description": "...", "inputSchema": {...}},
      {"name": "generate_terraform_hcl",    "description": "...", "inputSchema": {...}},
      {"name": "validate_terraform_plan",   "description": "...", "inputSchema": {...}}
    ]
  }
}
```

This happens **once at connection time**. Claude reads the full schema of
every tool from the server. In Version 1, the equivalent information was
serialised into every single `client.messages.create()` call as the `tools=`
parameter.

---

### 2.4 How Claude decides to call a tool

There is no Python loop deciding the sequence. The user types:

> "Scan my AWS account and tell me what security issues exist."

Claude reads all 7 tool schemas (already in its context from the handshake)
and internally decides to call `scan_ec2_instances`. It sends:

```
CLIENT → SERVER
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "scan_ec2_instances",
    "arguments": {"region": "us-east-1"}
  }
}
```

The MCP server receives this, executes:

```python
# mcp_server.py:73
return scan_ec2(region=region)
# scan_ec2 uses boto3.client("ec2") — reads AWS_ACCESS_KEY_ID from os.environ
# which was loaded from .env at startup
```

And returns:

```
SERVER → CLIENT
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"status\": \"ok\", \"count\": 3, \"instances\": [...]}"
      }
    ]
  }
}
```

Claude reads the result, reasons about it, and decides its next action
independently — maybe calling `scan_s3_buckets`, maybe calling
`analyse_security_findings` with the combined data. There is no
predetermined sequence enforced by Python code.

---

### 2.5 Credential handling — the key architectural difference

**Version 1** (Tool Use API):
```
Frontend → HTTP POST body → credentials dict → boto3.Session(
    aws_access_key_id=credentials["aws_access_key_id"],
    aws_secret_access_key=credentials["aws_secret_access_key"]
)
```
A new boto3 session is created per request with the user-supplied keys.
Different users can supply different keys in different requests.

**Version 2** (MCP):
```
.env file → load_dotenv() at server startup → os.environ → boto3 reads
AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY automatically
```
boto3 reads from the environment variables that were loaded once at
process startup. The server has exactly one AWS identity for its entire
lifetime. There is no mechanism for a caller to supply different credentials
per tool call.

---

### 2.6 No dispatch table

There is no equivalent of `dispatch_tool()` in the MCP version. FastMCP
routes `tools/call` requests directly to the decorated function by name.
The routing table is maintained by the framework, not by the application.

**Version 1 dispatch flow:**
```
LLM response block  →  block.name  →  dispatch_tool()  →  if/elif chain  →  handler
```

**Version 2 dispatch flow:**
```
tools/call.name  →  FastMCP internal registry  →  decorated function
```

No application code touches the routing. If a tool is renamed in
Version 1, the developer must update the `if/elif` in `dispatch_tool()`.
In Version 2, renaming the Python function is the only change needed.

---

### 2.7 No iteration counter, no loop state

**Version 1** maintains explicit loop state in `agent_service.py`:

```python
messages          = [...]    # grows with every iteration
collected_hcl     = ""       # updated when generate_terraform fires
collected_plan_output = ""   # updated when run_terraform_plan fires
collected_summary = ""       # updated when summarise_plan fires
iteration         = 0        # manually incremented, checked against MAX_ITERATIONS=6
```

If the LLM tries to call more tools than expected, the loop exits at
iteration 6 regardless. The application enforces the upper bound.

**Version 2**: none of this state exists in server code. Claude's context
window is the state. There is no iteration counter. If Claude calls
`scan_ec2_instances` ten times in a conversation, the server executes it
ten times — it has no concept of how many times it has been called. The
client (Claude) decides when it has enough information.

---

### 2.8 Resources vs tools — a concept that only exists in MCP

MCP has a second primitive that Version 1 has no equivalent of: resources.

```python
# mcp_server.py:364-407
@mcp.resource("aws://findings/{region}")
def aws_findings_resource(region: str) -> dict:
    """Latest security findings for an AWS region, pulled on demand."""
    scan_data = {
        "ec2":             scan_ec2(region=region),
        "s3":              scan_s3(),
        "iam":             scan_iam(),
        "security_groups": scan_security_groups(region=region),
        "vpc":             scan_vpc(region=region),
    }
    findings = run_security_analysis(scan_data)
    ...
```

A resource is fetched with a URI (`aws://findings/us-east-1`) rather than
a function call. The client includes it in Claude's context like reading a
file — not as a tool call that Claude decides to make mid-conversation.

In Version 1, all scan data was injected into the initial user message as a
JSON string. Every API call carried the full context. In Version 2, Claude
can fetch a resource only when it needs it, keeping the context window
smaller for unrelated conversations.

---

### 2.9 Full MCP execution timeline

```
[server starts — one time]
  │
  ├─ load_dotenv(".env")         → AWS keys, API keys into os.environ
  ├─ @mcp.tool() decorators run  → registry built from function signatures
  └─ mcp.run()                   → stdio loop begins, waiting for client

[client connects]
  │
  ├─ initialize handshake        → capabilities exchanged
  └─ tools/list                  → client receives all 7 tool schemas

[user says: "check my AWS security"]
  │
  ├─ Claude calls tools/call: scan_ec2_instances({"region": "us-east-1"})
  │   └─ scan_ec2(region="us-east-1")  → boto3 → AWS EC2 API
  │
  ├─ Claude calls tools/call: scan_s3_buckets({})
  │   └─ scan_s3()  → boto3 → AWS S3 API
  │
  ├─ Claude calls tools/call: analyse_security_findings({"scan_data": {...}})
  │   └─ run_security_analysis(scan_data)  [pure Python]
  │
  └─ Claude synthesises findings into a reply to the user
     [no loop counter, no Python state, no explicit sequence enforced]
```

**No Anthropic API calls from the server** — Claude is the client, not a
service the server calls. The server only executes boto3 and Python logic.

**No subprocess calls** unless `validate_terraform_plan` is invoked — and
only then, in a temp directory, for validation only (no `tfplan` saved).

---

## Part 3 — Side-by-Side Execution Comparison

### The same question: "What are my security issues?"

| Step | Version 1 (Tool Use API) | Version 2 (MCP) |
|---|---|---|
| Trigger | `POST /agent/run` HTTP request | User message in Claude Desktop |
| AWS credentials | Passed in request body, per-request boto3 session | In `.env`, loaded at server startup, one boto3 session per process |
| When scanning happens | Always, before any LLM call, all 5 services at once | When Claude decides to call scan tools, one at a time or all at once |
| LLM call to start | After scan complete, with full findings in first message | Claude already has tool schemas from handshake; no separate startup LLM call |
| How tools are listed | `tools=TOOLS` parameter in every `client.messages.create()` call | Sent once at `tools/list` handshake |
| Tool schema format | Hand-written `{"name": ..., "input_schema": {...}}` dicts | Auto-derived from Python function signatures and docstrings |
| Who decides tool sequence | Agent loop reads `response.stop_reason`, explicitly sequences calls | Claude decides independently based on what it receives |
| Routing a tool call | `dispatch_tool()` if/elif chain in `terraform_service.py:491` | FastMCP internal registry, no application code involved |
| Iteration safety | `MAX_ITERATIONS = 6` hard cap in `agent_service.py:46` | No cap — Claude's own reasoning determines when to stop |
| State between tool calls | `messages[]` list + `collected_hcl`, `collected_plan_output`, `collected_summary` variables | Claude's context window — no application variables |
| Conversation history | Application builds and manages the messages array | Client (Claude Desktop) manages conversation state |
| Human approval gate | Hard-coded: `POST /agent/approve` endpoint, `approved=True` required in request body | Not implemented — destructive tools excluded from MCP server |
| Execution log | `execution_log.json` written by `log_execution()` | No built-in log — would need to be added as a tool side-effect |
| Transport | HTTPS to `api.anthropic.com` | JSON-RPC 2.0 over stdio |
| LLM provider | Anthropic only (SDK hardcoded) | Any MCP-compatible client |
| Server process lifetime | One async coroutine per HTTP request | Long-running process for the entire Claude Desktop session |
| Adding a new tool | Edit schema dict + add to `TOOLS` list + add branch in `dispatch_tool()` | Add one `@mcp.tool()` decorated function |

---

### The terraform plan flow specifically

**Version 1** — tool call sequence is enforced by the system prompt:

```
System prompt: "generate_terraform → run_terraform_plan → summarise_plan_for_human"
```

If Claude tries to call `summarise_plan_for_human` before `run_terraform_plan`,
the loop still runs it — the sequence is a suggestion via prompt, not a
code constraint. The `collected_plan_output` variable will be empty, and the
summary will be based on nothing. This is a silent failure mode.

**Version 2** — Claude reasons about the sequence from the tool docstrings:

The `analyse_security_findings` docstring says:
> "You should call scan_ec2_instances, scan_s3_buckets, and other scan tools first,
> then pass their combined output here."

Claude reads this and calls scan tools first. If it doesn't, it gets back
`{"total_findings": 0}` because no scan data was provided — a visible,
self-correcting failure mode rather than a silent one.

---

### Token cost difference

**Version 1**: The `TOOLS` list (4 dicts with full `input_schema` JSON) is
serialised and sent to Anthropic on every iteration. For a 3-iteration run:

```
Call 1: system_prompt + initial_message + tools × 4
Call 2: ... + tool_result_1          + tools × 4  (repeated)
Call 3: ... + tool_result_1 + tool_result_2 + tools × 4  (repeated again)
```

The tool schemas are re-sent on every call. As the messages array grows,
the total tokens per call increases monotonically.

**Version 2**: Tool schemas are sent once at the `tools/list` handshake.
Each subsequent `tools/call` sends only the tool name and arguments — a
fraction of the token cost per invocation.

---

## Part 4 — What Was Preserved, What Was Replaced

### Code that is identical in both versions

Both versions call the exact same underlying functions:

| Function | File | Both versions call it |
|---|---|---|
| `scan_ec2()` | `services/aws_scanner.py:25` | Yes |
| `scan_s3()` | `services/aws_scanner.py:112` | Yes |
| `run_security_analysis()` | `services/security_analyzer.py:494` | Yes |
| `get_current_month_cost()` | `services/cost_analyzer.py:25` | Yes |
| `validate_terraform_syntax()` | `services/terraform_service.py:102` | Yes |
| `generate_terraform()` | `services/terraform_service.py:235` | Yes |

The business logic was never touched. MCP is a new interface layer on top
of the same functions.

### Code that exists only in Version 1

| Code | Location | Purpose |
|---|---|---|
| `TERRAFORM_TOOL`, `RUN_PLAN_TOOL`, `SUMMARISE_PLAN_TOOL` dicts | `terraform_service.py:11-85` | Anthropic tool schemas |
| `TOOLS` list | `terraform_service.py:85` | Passed in every API call |
| `dispatch_tool()` | `terraform_service.py:491` | Routes tool_name → handler |
| `while iteration < MAX_ITERATIONS` loop | `agent_service.py:127` | Drives the agentic loop |
| `messages[]` conversation history management | `agent_service.py:119-190` | Maintains multi-turn state |
| `anthropic.Anthropic(api_key=api_key)` SDK init | `agent_service.py:117` | Per-request client creation |
| `run_security_agent()` async function | `agent_service.py:54` | The entire agentic orchestration |
| `approve_and_apply()` async function | `agent_service.py:241` | Applies after human gate |

### Code that exists only in Version 2

| Code | Location | Purpose |
|---|---|---|
| `mcp = FastMCP("agentic-cloud-assistant")` | `mcp_server.py:30` | Server instance |
| `@mcp.tool()` decorated functions | `mcp_server.py:33-355` | All 7 tools |
| `@mcp.resource()` decorated functions | `mcp_server.py:364-448` | 2 URI-addressable data sources |
| `load_dotenv(...)` at startup | `mcp_server.py:14` | Credential loading |
| `mcp.run()` | `mcp_server.py:452` | stdio event loop |
