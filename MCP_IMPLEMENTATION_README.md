# MCP Implementation — Agentic Cloud Assistant

## 1. What MCP Is and How It Differs from the Tool Use API

### The Tool Use API (what this project had before)

In the original `agent_service.py`, the Python application owns the entire
loop. The application calls the Anthropic API, receives a `tool_use` block,
executes the correct function itself via `dispatch_tool()`, packages the
result back into a `tool_result` message, and calls the API again. Every
tool — `generate_terraform`, `run_terraform_plan`, `summarise_plan_for_human`
— is a plain Python function inside this project. The LLM cannot discover
or call any of them without the application explicitly running that loop.

```
[FastAPI app]
     │
     ├─── calls Anthropic API (with tools= list hardcoded in Python)
     │
     ◄─── receives tool_use block
     │
     ├─── dispatch_tool()  ← app is in control here
     │         └─── calls scan_ec2() / run_terraform_plan() / etc.
     │
     └─── feeds tool_result back to Anthropic API
```

The application decides when tools run, how results are formatted, and
when the loop stops. Claude cannot reach any tool that is not wired into
`dispatch_tool()`.

### The Model Context Protocol (what this phase adds)

MCP **inverts this control**. Instead of the application dispatching tool
calls on behalf of Claude, the MCP server *publishes* tools that any
MCP-compatible client (Claude Desktop, Claude Code, a CI pipeline) can
discover and invoke directly. The server does not run a loop — it simply
answers when called.

```
[Claude Desktop / Claude Code]
     │
     ├─── discovers tools by reading mcp_server.py over stdio
     │         (no hardcoded list — Claude reads the schema at startup)
     │
     ├─── decides ITSELF when to call scan_ec2_instances()
     │
     ◄─── mcp_server.py executes the function and returns the result
     │
     └─── Claude continues reasoning with the result
```

The key difference in plain English: **with Tool Use, your code runs the
loop and tells Claude about tools. With MCP, Claude runs the loop and asks
your server to execute tools.**

This means:
- Any MCP client can use these tools — not just this application.
- Tools are discovered dynamically at startup, not compiled into a list.
- Adding a new tool requires only a new `@mcp.tool()` function — no
  changes to dispatch logic, no changes to the agent loop.

---

## 2. Connecting Claude Desktop

### Prerequisites

- Claude Desktop installed (Mac or Windows)
- Python 3.11+ with the project's virtual environment set up
- AWS credentials configured as environment variables or in `~/.aws/credentials`

### Step 1 — Find your Claude Desktop config file

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

### Step 2 — Add the server block

Open the config file (create it if it does not exist) and add:

```json
{
  "mcpServers": {
    "agentic-cloud-assistant": {
      "command": "/absolute/path/to/venv/bin/python",
      "args": ["/absolute/path/to/ACA-MCP/backend/mcp_server.py"],
      "env": {
        "PYTHONPATH": "/absolute/path/to/ACA-MCP/backend",
        "AWS_ACCESS_KEY_ID": "your-key-id",
        "AWS_SECRET_ACCESS_KEY": "your-secret-key",
        "AWS_DEFAULT_REGION": "us-east-1",
        "ANTHROPIC_API_KEY": "your-anthropic-key"
      }
    }
  }
}
```

A ready-to-edit copy is at `claude_desktop_config_example.json` in the
project root.

**Important:** Use absolute paths. Claude Desktop launches the server as a
subprocess and does not inherit your shell's working directory or PATH.

### Step 3 — Restart Claude Desktop

Quit and reopen Claude Desktop. The server starts automatically when Claude
launches. You should see "agentic-cloud-assistant" listed under the tools
icon (hammer) in the chat interface.

### Step 4 — Verify

Type in Claude Desktop:

> "Call health_check on the agentic-cloud-assistant server."

Expected response: `{"status": "ok", "server": "agentic-cloud-assistant"}`

---

## 3. Tools Reference

All tools are defined in `backend/mcp_server.py`. AWS tools use ambient
credentials from the server's environment — never pass credentials as
tool parameters.

---

### `health_check`

**Purpose:** Verify the MCP server is connected and responding.

**Parameters:** None

**Returns:**
```json
{"status": "ok", "server": "agentic-cloud-assistant"}
```

---

### `scan_ec2_instances`

**Purpose:** List all EC2 instances in an AWS region with their state,
type, IP addresses, and attached security groups.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| `region` | string | `"us-east-1"` | AWS region, e.g. `"eu-west-1"` |

**Returns:**
```json
{
  "status": "ok",
  "count": 3,
  "instances": [
    {
      "id": "i-0abc1234def56789",
      "name": "web-server",
      "type": "t3.micro",
      "state": "running",
      "public_ip": "54.1.2.3",
      "private_ip": "10.0.1.5",
      "launch_time": "2026-01-15 10:30:00+00:00",
      "security_group_ids": ["sg-0abc1234"]
    }
  ]
}
```

On error: `{"status": "error", "error": "...", "count": 0, "instances": []}`

---

### `scan_s3_buckets`

**Purpose:** List all S3 buckets in the account and flag any that are
publicly accessible via an AllUsers ACL grant.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| `region` | string | `"us-east-1"` | Accepted but ignored — S3 is global |

**Returns:**
```json
{
  "status": "ok",
  "count": 2,
  "buckets": [
    {
      "name": "my-private-bucket",
      "created": "2025-06-01 12:00:00+00:00",
      "is_public": false
    },
    {
      "name": "my-public-bucket",
      "created": "2025-07-15 09:00:00+00:00",
      "is_public": true
    }
  ]
}
```

---

### `analyse_security_findings`

**Purpose:** Run 7 built-in security rules against raw scan data and
return structured findings sorted by severity (HIGH → MEDIUM → LOW).

Call the scan tools first, combine their outputs into a single dict,
then pass that dict here.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `scan_data` | dict | Combined output of scan tools. Keys: `"ec2"`, `"s3"`, `"iam"`, `"security_groups"`, `"vpc"`. Missing keys are handled safely. |

**Rules applied:**

| Severity | Rule | Condition |
|---|---|---|
| HIGH | `SSH_PORT_OPEN` | Port 22 open to `0.0.0.0/0` |
| HIGH | `RDP_PORT_OPEN` | Port 3389 open to `0.0.0.0/0` |
| HIGH | `S3_BUCKET_PUBLIC` | Bucket has AllUsers ACL grant |
| HIGH | `UNRESTRICTED_ALL_TRAFFIC` | Security group allows all protocols from internet |
| MEDIUM | `IAM_USER_NO_MFA` | IAM user has no MFA device |
| LOW | `IAM_USER_INACTIVE` | IAM user not logged in for 90+ days |
| LOW | `DEFAULT_VPC_IN_USE` | Default VPC exists in region |

**Returns:**
```json
{
  "total_findings": 2,
  "severity_counts": {"HIGH": 1, "MEDIUM": 1, "LOW": 0},
  "findings": [
    {
      "finding_id": "SSH_PORT_OPEN-sg-0abc1234-0",
      "resource_id": "sg-0abc1234",
      "resource_type": "EC2_SECURITY_GROUP",
      "rule": "SSH_PORT_OPEN",
      "severity": "HIGH",
      "title": "SSH port exposed to the internet",
      "description": "Security group allow-all allows SSH (port 22) access from any IP...",
      "recommendation": "Restrict port 22 to specific trusted IP addresses only.",
      "metadata": {"port": 22, "group_name": "allow-all"}
    }
  ]
}
```

---

### `estimate_costs`

**Purpose:** Retrieve current AWS spend, monthly trend, per-service
breakdown, and detect cost anomalies (20%+ month-over-month increase).
Requires the `ce:GetCostAndUsage` IAM permission.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| `region` | string | `"us-east-1"` | Accepted but ignored — Cost Explorer is global |
| `time_period_days` | integer | `30` | Look-back window. Converted to months: `30`→1 month, `90`→3 months, `180`→6 months |

**Returns:**
```json
{
  "current_month": {"amount": 47.83, "currency": "USD", "period": "2026-04-01 to 2026-04-22"},
  "monthly_trend": [
    {"month": "2026-02", "amount": 38.10, "currency": "USD"},
    {"month": "2026-03", "amount": 41.55, "currency": "USD"},
    {"month": "2026-04", "amount": 47.83, "currency": "USD"}
  ],
  "by_service": [
    {"service": "Amazon EC2", "amount": 31.20, "currency": "USD"},
    {"service": "Amazon S3", "amount": 9.40, "currency": "USD"}
  ],
  "anomaly": {"detected": false, "message": "", "percentage": 0.0},
  "months_fetched": 1
}
```

---

### `generate_terraform_hcl`

**Purpose:** Generate complete, validated Terraform HCL for an AWS
resource using an LLM. Automatically runs `terraform init` and
`terraform validate` on the output.

Requires `ANTHROPIC_API_KEY` or `GROQ_API_KEY` to be set in the
server's environment. Prefers Anthropic if both are set.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `resource_type` | string | Plain-English or Terraform resource name, e.g. `"aws_s3_bucket"` or `"EC2 instance with a security group"` |
| `config` | dict | Configuration options to include, e.g. `{"instance_type": "t3.micro"}`. Pass `{}` for LLM defaults. |

**Returns:**
```json
{
  "hcl": "terraform {\n  required_providers {\n    aws = ...\n  }\n}\n...",
  "explanation": "Creates a t3.micro EC2 instance with a security group allowing HTTP/HTTPS",
  "valid": true,
  "validation_message": "Terraform configuration is valid.",
  "resource_type": "aws_instance",
  "error": null
}
```

If generation fails: `"error"` is set to a plain-English reason; `"valid"` is `false`.

---

### `validate_terraform_plan`

**Purpose:** Validate Terraform HCL syntax without touching AWS. Runs
`terraform init -backend=false` followed by `terraform validate` in a
temporary directory that is deleted afterwards. Requires `terraform`
on the server's PATH.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `hcl` | string | Complete Terraform HCL content including `terraform{}`, `provider{}`, and `resource{}` blocks |

**Returns:**
```json
{
  "valid": false,
  "errors": [
    "Error: Unsupported argument",
    "  on main.tf line 12, in resource \"aws_instance\" \"main\":"
  ],
  "warnings": [],
  "message": "Error: Unsupported argument\n  on main.tf line 12..."
}
```

On success: `"valid": true`, `"errors": []`, `"warnings": []`.

---

## 4. Resources Reference

Resources are data endpoints Claude can pull on demand. Unlike tools,
they are not triggered by Claude deciding to act — they are fetched
when Claude needs to read current state to answer a question.

---

### `aws://findings/{region}`

**Purpose:** Run a full five-service scan and return security findings
for the region, without requiring a separate scan + analyse call.

**URI examples:**
```
aws://findings/us-east-1
aws://findings/eu-west-1
aws://findings/ap-southeast-1
```

**Returns:** Same structure as `analyse_security_findings`, plus a
top-level `"region"` key echoing the URI parameter.

**Services scanned:** EC2, S3 (global), IAM (global), Security Groups, VPC.

---

### `aws://cost-summary/{region}`

**Purpose:** Return the current month's AWS cost summary without
requiring an explicit `estimate_costs` tool call.

**URI examples:**
```
aws://cost-summary/us-east-1
```

Note: Cost Explorer is global — the region in the URI is not used to
filter data. All regions' spend is always included.

**Returns:** Same structure as `estimate_costs` with `months_fetched=3`,
plus a top-level `"region"` key.

---

## 5. Testing Manually

### Start the server in dev mode

```bash
cd backend
source venv/bin/activate

# Run the server directly (exits immediately without a client — that is normal)
python mcp_server.py

# Test with the MCP inspector (requires npx)
npx @modelcontextprotocol/inspector python mcp_server.py
```

The MCP inspector opens a browser UI where you can browse registered
tools, view their schemas, and call them manually.

### Smoke-test individual tools in Python

```bash
cd backend
source venv/bin/activate
python - <<'EOF'
from mcp_server import health_check, scan_s3_buckets, analyse_security_findings

# 1. Verify server is live
print(health_check())

# 2. Scan S3 (uses ambient AWS credentials)
s3_result = scan_s3_buckets()
print(f"S3 buckets found: {s3_result['count']}")

# 3. Run security analysis on empty data (no AWS call — safe to test)
print(analyse_security_findings({}))
EOF
```

### Validate generated Terraform without AWS credentials

```bash
cd backend
source venv/bin/activate
python - <<'EOF'
from mcp_server import validate_terraform_plan

SAMPLE_HCL = """
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
provider "aws" { region = "us-east-1" }
resource "aws_s3_bucket" "main" {
  bucket = "test-bucket-mcp-demo"
}
"""
result = validate_terraform_plan(SAMPLE_HCL)
print("Valid:", result["valid"])
print("Message:", result["message"])
EOF
```

### Verify the server process holds open (stdio mode)

```bash
cd backend
source venv/bin/activate
python mcp_server.py &
MCP_PID=$!
sleep 2
kill -0 $MCP_PID && echo "Server running OK" || echo "Server crashed"
kill $MCP_PID
```

---

## 6. What Was NOT Migrated and Why

### Human-in-the-loop approval gate

**What it is:** The `POST /agent/approve/{execution_id}` and
`POST /terraform/apply` endpoints in `main.py` that require an explicit
`approved=True` from the user before any Terraform changes are applied.

**Why it was not migrated:** The approval gate is an HTTP endpoint concern,
not a tool. An MCP tool executes immediately when Claude calls it — there
is no built-in mechanism for a tool to pause mid-call and wait for a human
to click "Approve" in a UI. Wrapping `run_terraform_apply` as an MCP tool
would allow Claude to call it without any human gate.

**The tradeoff:** For safety-critical infrastructure changes, the FastAPI
approval gate provides a hard constraint that MCP cannot replicate without
custom middleware. The recommended pattern is: use MCP tools for scan +
plan + summarise (read-only), and keep the apply step behind a FastAPI
endpoint that enforces human approval.

### Per-request AWS credentials

**What it is:** `agent_service.py` and all boto3 calls accept a
`credentials: dict` containing `aws_access_key_id` and
`aws_secret_access_key` passed from the frontend on every request.

**Why it was not migrated:** MCP tools are server-side functions with no
per-call credential injection mechanism. The MCP server uses a single set
of ambient credentials (environment variables or IAM role) for its entire
lifetime. Supporting per-user credentials in MCP would require either (a)
a credential vault integration or (b) passing credentials as tool
parameters — which is a security anti-pattern.

**The tradeoff:** The MCP server works correctly in single-user and
server-with-IAM-role deployments. Multi-tenant credential isolation
requires the original FastAPI approach.

### LLM provider routing (Groq, Ollama)

**What it is:** `llm_service.py` supports three LLM providers — Anthropic,
Groq, and Ollama — selectable per request.

**Why it was not migrated:** These are conversational helper functions used
for summaries and the `/chat` endpoint. They do not represent actions the
MCP server should perform on Claude's behalf. When Claude uses the MCP
server, Claude itself is the LLM — routing to Groq or Ollama inside the
MCP server would mean an inferior model executing tool calls on behalf of
a more capable one.

### RAG knowledge base management endpoints

**What it is:** The `POST /rag/documents/upload`, `POST /rag/documents/text`,
and `DELETE /rag/documents/{doc_id}` endpoints for managing the ChromaDB
knowledge base.

**Why it was not migrated:** Document management involves file uploads and
multipart form data, which are HTTP-level concerns that don't map cleanly
to MCP tool parameters. The `query_security_knowledge_base` tool (from the
original `TOOLS` list) could be added as an MCP tool in a future phase —
it is a pure search operation with no upload complexity.
