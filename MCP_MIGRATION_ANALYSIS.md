# MCP Migration Analysis

## 1. TOOL DEFINITIONS

**Location:** `backend/services/terraform_service.py`, line 85

```python
TOOLS = [TERRAFORM_TOOL, RUN_PLAN_TOOL, SUMMARISE_PLAN_TOOL, RAG_TOOL_DEFINITION]
```

**Total tools: 4**

| Tool Name | Defined At | Type |
|---|---|---|
| `generate_terraform` | `terraform_service.py:11` (`TERRAFORM_TOOL`) | Hardcoded Python dict |
| `run_terraform_plan` | `terraform_service.py:35` (`RUN_PLAN_TOOL`) | Hardcoded Python dict |
| `summarise_plan_for_human` | `terraform_service.py:57` (`SUMMARISE_PLAN_TOOL`) | Hardcoded Python dict |
| `query_security_knowledge_base` | `rag/rag_service.py:73` (`RAG_TOOL_DEFINITION`) | Hardcoded Python dict (imported) |

All four tools are **hardcoded Python dicts** (`input_schema` follows Anthropic's tool format).
The `TOOLS` list at line 85 is assembled statically at import time — there is no factory or
registry pattern.

---

## 2. DISPATCH LOGIC

**Location:** `backend/services/terraform_service.py`, line 491

```python
def dispatch_tool(tool_name: str, tool_input: dict) -> dict:
    if tool_name == "generate_terraform":
        return handle_generate_terraform(**tool_input)
    elif tool_name == "run_terraform_plan":
        return handle_run_terraform_plan(**tool_input)
    elif tool_name == "summarise_plan_for_human":
        return handle_summarise_plan(**tool_input)
    elif tool_name == "query_security_knowledge_base":
        return handle_rag_tool_call(tool_input)
    else:
        return {"error": f"Unknown tool: {tool_name}"}
```

**Routing logic:** A simple `if/elif` chain matches `tool_name` (from the LLM's `tool_use` block)
to a Python handler function. `tool_input` is unpacked with `**` and passed as keyword arguments
(except `handle_rag_tool_call` which receives the dict whole). Returns a dict; never raises.

**Called from:** `agent_service.py:164`
```python
result = dispatch_tool(tool_name, tool_input)
```

---

## 3. AGENTIC LOOP

**Location:** `backend/agent_service.py`, line 127

```python
while iteration < MAX_ITERATIONS:
    iteration += 1

    response = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        tools=TOOLS,
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
        result = dispatch_tool(block.name, block.input)
        tool_results.append({
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": json.dumps(result, default=str),
        })

    if not tool_results:
        break

    messages.append({"role": "user", "content": tool_results})
```

**`MAX_ITERATIONS`:** Defined at `agent_service.py:46` as the constant `6`.

**Tool result packaging:** Each result becomes a `{"type": "tool_result", "tool_use_id": ...,
"content": json.dumps(result)}` dict (lines 177–183). All results from one response are batched
into a single user turn (line 190) before the next API call.

---

## 4. HUMAN-IN-THE-LOOP

**Two approval gates exist:**

### Gate 1 — Agent flow
**Location:** `backend/main.py:634`, endpoint `POST /agent/approve/{execution_id}`

```python
if not request.approved:
    log_execution_update(execution_id, {
        "approved": False,
        "status": "rejected",
        "apply_output": "User rejected the agent plan. No changes made.",
    })
    return {"status": "rejected"}

# approved=True path
result = await agent_service.approve_and_apply(execution_id, credentials)
```

### Gate 2 — Manual Terraform flow
**Location:** `backend/main.py:523`, endpoint `POST /terraform/apply`

```python
if not request.approved:
    log_execution_update(request.execution_id, {"approved": False, "status": "rejected", ...})
    return {"status": "rejected", ...}

result = run_terraform_apply(request.execution_id)
```

**Approval=True:** Calls `run_terraform_apply(execution_id)` in `execution_service.py:138`,
which runs `terraform apply -auto-approve tfplan` on the saved binary plan file. Updates
the execution log with the final status.

**Approval=False:** Logs the rejection immediately; no Terraform command is executed.

---

## 5. LLM PROVIDER ABSTRACTION

**Three providers are supported:** Anthropic, Groq, Ollama.

**Provider functions — `backend/services/llm_service.py`:**

| Function | Line | Transport | Model |
|---|---|---|---|
| `chat_with_groq()` | 10 | `httpx` → Groq REST API | `llama-3.3-70b-versatile` |
| `chat_with_ollama()` | 90 | `httpx` → `localhost:11434` | `minimax-m2.7:cloud` |
| `chat_with_anthropic()` | 224 | `httpx` → Anthropic REST API | `claude-haiku-4-5-20251001` |

**Important split:** `llm_service.py` uses raw `httpx` for all three providers.
However, the **agentic loop** (`agent_service.py:117`) bypasses `llm_service` entirely and
instantiates the Anthropic Python SDK directly:

```python
client = anthropic.Anthropic(api_key=api_key)  # agent_service.py:117
response = client.messages.create(model="claude-opus-4-5", tools=TOOLS, ...)
```

This SDK call is the one that drives the tool-use loop. The `llm_service.py` functions are
used only for conversational/summary calls (chat, security summary, cost insights, RAG answers)
where tool use is not required.

**What would break with MCP migration:**
- The `client.messages.create(tools=TOOLS, ...)` call in `agent_service.py` would need to be
  replaced with an MCP client that delegates tool execution to the MCP server.
- `llm_service.py` raw-httpx calls are unaffected by MCP (they don't do tool use).
- API keys are currently threaded per-request through all call sites; MCP server needs a
  consistent credential strategy.

---

## 6. AWS TOOL FUNCTIONS

### `backend/services/aws_scanner.py` — All boto3 wrappers

| Function | boto3 Calls | MCP Destination |
|---|---|---|
| `scan_ec2(region, credentials)` | `ec2.describe_instances()` | `@mcp.tool()` |
| `scan_s3(credentials)` | `s3.list_buckets()` + `s3.get_bucket_acl()` per bucket | `@mcp.tool()` |
| `scan_iam(credentials)` | `iam.list_users()` + `iam.list_mfa_devices()` per user | `@mcp.tool()` |
| `scan_security_groups(region, credentials)` | `ec2.describe_security_groups()` | `@mcp.tool()` |
| `scan_vpc(region, credentials)` | `ec2.describe_vpcs()` + `ec2.describe_subnets()` | `@mcp.tool()` |

### `backend/services/cost_analyzer.py` — boto3 Cost Explorer wrappers

| Function | boto3 Calls | MCP Destination |
|---|---|---|
| `get_current_month_cost(credentials)` | `ce.get_cost_and_usage()` (monthly, no group) | `@mcp.tool()` |
| `get_monthly_trend(months, credentials)` | `ce.get_cost_and_usage()` (monthly, N months) | `@mcp.tool()` |
| `get_cost_by_service(credentials)` | `ce.get_cost_and_usage()` (GROUP BY SERVICE) | `@mcp.tool()` |
| `detect_cost_anomaly(monthly_trend)` | Pure Python (no boto3) | Helper — stays internal |

### `backend/services/execution_service.py` — Execution management

| Function | What it does | MCP Destination |
|---|---|---|
| `run_terraform_plan(hcl_config, execution_id)` | `subprocess` terraform init + plan | `@mcp.tool()` |
| `run_terraform_apply(execution_id)` | `subprocess` terraform apply on saved tfplan | `@mcp.tool()` |
| `get_execution_history()` | Reads `execution_log.json` | `@mcp.resource()` |
| `log_execution(entry)` | Appends to `execution_log.json` | Internal helper |
| `log_execution_update(execution_id, updates)` | In-place update of log entry | Internal helper |
| `create_execution_id()` | UUID + timestamp generator | Internal helper |
| `get_working_dir(execution_id)` | mkdir for terraform workdir | Internal helper |

### `backend/services/terraform_service.py` — Terraform generation & dispatch

| Function | What it does | MCP Destination |
|---|---|---|
| `validate_terraform_syntax(hcl)` | `subprocess` terraform init + validate | `@mcp.tool()` |
| `handle_generate_terraform(hcl, ...)` | Passthrough — LLM already made the HCL | `@mcp.tool()` |
| `handle_run_terraform_plan(hcl_content, ...)` | `subprocess` terraform init + plan | `@mcp.tool()` |
| `handle_summarise_plan(plan_output, ...)` | Pure Python plan parser + formatter | `@mcp.tool()` |
| `generate_terraform_with_anthropic(request, key)` | LLM call (tool_choice forced) | Internal (orchestration) |
| `generate_terraform_with_groq(request, key)` | LLM call (JSON-mode prompt) | Internal (orchestration) |

### `backend/rag/rag_service.py`

| Function | What it does | MCP Destination |
|---|---|---|
| `query_knowledge_base(query, n_results, resource_filter)` | ChromaDB vector search | `@mcp.tool()` |
| `handle_rag_tool_call(tool_input)` | Wraps query_knowledge_base for dispatch | Merged into MCP tool |

### `backend/rag/knowledge_base.py` — ChromaDB wrapper

| Method | What it does | MCP Destination |
|---|---|---|
| `knowledge_base.add_document(doc_id, text, metadata)` | Chunk + embed + upsert to ChromaDB | `@mcp.tool()` |
| `knowledge_base.search(query, n_results)` | Vector similarity search | Called by RAG tool |
| `knowledge_base.list_documents()` | List all docs in ChromaDB | `@mcp.resource()` |
| `knowledge_base.delete_document(doc_id)` | Delete doc chunks from ChromaDB | `@mcp.tool()` |
| `knowledge_base.get_document_count()` | Count total chunks | Helper |

---

## 7. TERRAFORM HCL GENERATION

**HCL generation — two paths, both in `backend/services/terraform_service.py`:**

### Anthropic path (`generate_terraform_with_anthropic`, line 147)
- Creates an `anthropic.Anthropic` client
- Calls `client.messages.create(tools=[TERRAFORM_TOOL], tool_choice={"type": "tool", "name": "generate_terraform"})`
- The forced `tool_choice` guarantees a `tool_use` block in the response
- Extracts `block.input` → `{"hcl": str, "resource_type": str, "description": str}`

### Groq path (`generate_terraform_with_groq`, line 180)
- Calls Groq REST API via the `Groq` SDK
- Prompts with an explicit fenced-block format (HCL in ` ```hcl `, metadata in ` ```json `)
- Parses the output with two `re.search` calls (lines 219–226)
- No native tool_choice support — relies on prompt engineering

### Routing (`generate_terraform`, line 235)
- Selects Anthropic or Groq based on the `model` parameter
- Always calls `validate_terraform_syntax(result["hcl"])` after generation
- Returns `{"hcl", "resource_type", "description", "validation", "error"}`

### Validation (`validate_terraform_syntax`, line 102)
- Creates a `tempfile.TemporaryDirectory`
- Writes `main.tf`, runs `terraform init -backend=false` then `terraform validate`
- Returns `{"valid": bool, "message": str}`
- Temp dir is auto-deleted; **does NOT save a plan file**

### Return path to frontend
- Endpoint: `POST /terraform/generate` in `main.py:426`
- Calls `await generate_terraform(request.request, request.model, resolved_key)`
- Returns full JSON response including `hcl`, `validation`, `model_used`

---

## MIGRATION PLAN

### Functions to wrap as `@mcp.tool()`

| MCP Tool Name | Source Function | Source File |
|---|---|---|
| `scan_ec2` | `scan_ec2()` | `services/aws_scanner.py` |
| `scan_s3` | `scan_s3()` | `services/aws_scanner.py` |
| `scan_iam` | `scan_iam()` | `services/aws_scanner.py` |
| `scan_security_groups` | `scan_security_groups()` | `services/aws_scanner.py` |
| `scan_vpc` | `scan_vpc()` | `services/aws_scanner.py` |
| `get_current_month_cost` | `get_current_month_cost()` | `services/cost_analyzer.py` |
| `get_monthly_trend` | `get_monthly_trend()` | `services/cost_analyzer.py` |
| `get_cost_by_service` | `get_cost_by_service()` | `services/cost_analyzer.py` |
| `run_terraform_plan` | `run_terraform_plan()` | `services/execution_service.py` |
| `run_terraform_apply` | `run_terraform_apply()` | `services/execution_service.py` |
| `validate_terraform_syntax` | `validate_terraform_syntax()` | `services/terraform_service.py` |
| `generate_terraform` | `handle_generate_terraform()` + LLM generation | `services/terraform_service.py` |
| `run_terraform_plan_agent` | `handle_run_terraform_plan()` | `services/terraform_service.py` |
| `summarise_plan_for_human` | `handle_summarise_plan()` | `services/terraform_service.py` |
| `query_security_knowledge_base` | `query_knowledge_base()` / `handle_rag_tool_call()` | `rag/rag_service.py` |
| `add_knowledge_document` | `knowledge_base.add_document()` | `rag/knowledge_base.py` |
| `delete_knowledge_document` | `knowledge_base.delete_document()` | `rag/knowledge_base.py` |

### Data sources to expose as `@mcp.resource()`

| URI | Source Function | Source File |
|---|---|---|
| `execution://history` | `get_execution_history()` | `services/execution_service.py` |
| `execution://{execution_id}` | `get_execution_history()` filtered | `services/execution_service.py` |
| `knowledge://documents` | `knowledge_base.list_documents()` | `rag/knowledge_base.py` |
| `aws://scan/{region}` | All 5 `scan_*` functions combined | `services/aws_scanner.py` |

### Files to CREATE (new)

| File | Purpose |
|---|---|
| `backend/mcp_server.py` | Main MCP server entry point — registers all `@mcp.tool()` and `@mcp.resource()` decorators, holds the `mcp = FastMCP(...)` instance |
| `backend/mcp_tools/aws_tools.py` | Thin MCP wrappers around `aws_scanner.py` functions |
| `backend/mcp_tools/cost_tools.py` | Thin MCP wrappers around `cost_analyzer.py` functions |
| `backend/mcp_tools/terraform_tools.py` | Thin MCP wrappers around `terraform_service.py` + `execution_service.py` functions |
| `backend/mcp_tools/rag_tools.py` | Thin MCP wrappers around `rag_service.py` + `knowledge_base.py` |
| `backend/mcp_tools/__init__.py` | Package init |

### Files to MODIFY (and what specifically changes)

| File | Changes Required |
|---|---|
| `backend/agent_service.py` | Replace direct `anthropic.Anthropic` SDK usage (line 117) with an MCP client; replace the `TOOLS` list import and `dispatch_tool()` call with MCP tool invocation via the client |
| `backend/services/terraform_service.py` | Remove `TOOLS`, `dispatch_tool()`, and the individual `handle_*` functions once they are wrapped in MCP tools; keep `generate_terraform*` and `validate_terraform_syntax` as internal helpers called by the MCP tools |
| `backend/main.py` | Add MCP server mount or startup logic; update imports if any internal service modules are restructured; credential handling must align with MCP tool signatures |
| `backend/requirements.txt` | Add `mcp` (or `fastmcp`) package |

### Items that CANNOT be directly migrated and why

| Item | Reason |
|---|---|
| **Per-request AWS credentials** | Current design passes `credentials: dict` (access key + secret) from the frontend into every boto3 call. MCP tools run server-side and must have a stable credential strategy — either environment/IAM role credentials baked into the server, or a credential-passing convention through tool inputs. The current per-request model is incompatible with the MCP server's stateless tool model without explicit parameter threading. |
| **`chat_with_groq` / `chat_with_ollama` / `chat_with_anthropic` in `llm_service.py`** | These are not tool-dispatch functions — they are direct conversational LLM calls used for summaries and the chat endpoint. They do not map to MCP tools. They stay as internal service helpers called by FastAPI endpoints. |
| **`generate_terraform_with_anthropic` and `generate_terraform_with_groq`** | These are LLM orchestration functions (they call an LLM and parse its output), not side-effecting actions. They are best kept as internal helpers invoked by the `generate_terraform` MCP tool, not as MCP tools themselves. |
| **`detect_cost_anomaly(monthly_trend)`** | Pure Python computation with no I/O. It is a helper function, not an MCP tool. Stays internal. |
| **`log_execution()` and `log_execution_update()`** | Write-only side effects that pair with `run_terraform_plan` and `run_terraform_apply`. These are internal bookkeeping helpers, not separately callable tools. They stay inside the Terraform MCP tools. |
| **The approval gate (`/agent/approve`, `/terraform/apply`)** | Human-in-the-loop approval is an HTTP endpoint concern, not an MCP tool. The approval endpoints in `main.py` remain as FastAPI POST routes; they call the `run_terraform_apply` MCP tool under the hood after the human approves. |
| **ChromaDB persistent client** | ChromaDB uses a file-path-based `PersistentClient`. This couples the MCP server to the local filesystem. In a distributed MCP deployment this would need a remote Chroma instance. For now it works as-is but should be noted as a deployment constraint. |
