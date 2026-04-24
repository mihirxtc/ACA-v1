# Tool Use API vs MCP — Technical Comparison

This document compares the two agentic architectures implemented in this
project: the original **Anthropic Tool Use API** approach in
`agent_service.py` / `terraform_service.py`, and the new
**Model Context Protocol** approach in `mcp_server.py`.

---

## 1. Architecture Difference — Who Owns the Loop

### Tool Use API: Application-controlled loop

```
┌─────────────────────────────────────────────────────────────────┐
│  agent_service.py                                               │
│                                                                 │
│  while iteration < MAX_ITERATIONS:           ← app controls    │
│      response = anthropic_client.messages.create(...)          │
│      if stop_reason == "tool_use":                             │
│          result = dispatch_tool(name, input) ← app dispatches  │
│          messages.append(tool_result)                          │
│      elif stop_reason == "end_turn":                           │
│          break                               ← app decides stop │
└─────────────────────────────────────────────────────────────────┘
```

The Python application drives every iteration. It decides when the loop
starts, when it ends, how many iterations are allowed (`MAX_ITERATIONS=6`),
and exactly which functions are callable (`TOOLS` list in `terraform_service.py`).
Claude cannot call a tool that has not been explicitly registered and wired
into `dispatch_tool()`.

**Control flow:** Application → Anthropic API → Application → Anthropic API → …

### MCP: Client-controlled loop

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Desktop / Claude Code (the MCP client)                  │
│                                                                 │
│  [Claude decides to call scan_ec2_instances]  ← Claude controls │
│      → stdio → mcp_server.py executes scan_ec2()               │
│      ← result returned over stdio                               │
│  [Claude decides what to do next]             ← Claude decides  │
│  [Claude calls analyse_security_findings]                       │
│      → stdio → mcp_server.py executes run_security_analysis()  │
└─────────────────────────────────────────────────────────────────┘
```

The MCP server is stateless and reactive. It publishes tools and waits.
Claude decides when to call them, in what order, and when to stop. The
server has no loop, no iteration counter, and no knowledge of what Claude
is trying to achieve.

**Control flow:** MCP Client (Claude) → MCP Server → MCP Client → …

### Summary table

| Dimension | Tool Use API | MCP |
|---|---|---|
| Loop owner | Python application | Claude / MCP client |
| Stop condition | `stop_reason == "end_turn"` or `MAX_ITERATIONS` | Client decides |
| Tool discovery | Hardcoded `TOOLS` list passed in every API call | Server advertises at startup |
| Tool execution | `dispatch_tool()` in Python | Server executes on demand |
| State between calls | `messages[]` list in application memory | Stateless (client holds context) |

---

## 2. Tool Discovery — Hardcoded vs Auto-Discovered

### Tool Use API: compile-time registration

```python
# terraform_service.py — tools are plain Python dicts
TERRAFORM_TOOL = {
    "name": "generate_terraform",
    "description": "...",
    "input_schema": {...}
}
TOOLS = [TERRAFORM_TOOL, RUN_PLAN_TOOL, SUMMARISE_PLAN_TOOL, RAG_TOOL_DEFINITION]

# agent_service.py — list passed on every API call
response = client.messages.create(
    model="claude-opus-4-5",
    tools=TOOLS,          ← explicit, hardcoded
    messages=messages,
)
```

Adding a new tool requires: (1) writing the dict, (2) adding it to `TOOLS`,
(3) adding a branch to `dispatch_tool()`. Three touch points, all in
different functions. Forgetting step 3 means the tool is offered to Claude
but silently returns `{"error": "Unknown tool: ..."}` when called.

### MCP: decorator-based auto-discovery

```python
# mcp_server.py — decorator registers the tool automatically
@mcp.tool()
def scan_ec2_instances(region: str = "us-east-1") -> dict:
    """Scan all EC2 instances in the specified AWS region..."""
    return scan_ec2(region=region)
```

The schema (parameter names, types, defaults, description) is derived
directly from the function signature and docstring. Adding a new tool is
one step: write the function with `@mcp.tool()`. No dispatch table, no
separate schema dict, no registration call.

### Impact

| Dimension | Tool Use API | MCP |
|---|---|---|
| Steps to add a tool | 3 (dict + TOOLS list + dispatch branch) | 1 (decorated function) |
| Schema drift risk | High (dict can diverge from implementation) | None (schema derived from code) |
| Discovery mechanism | Caller must pass the list every time | Server advertises at connection time |
| Runtime changes | Requires code change + redeploy | Requires code change + server restart |

---

## 3. Multi-LLM Compatibility

### Tool Use API: Anthropic-only (for the agentic loop)

The agentic loop in `agent_service.py` is hard-wired to the Anthropic SDK:

```python
client = anthropic.Anthropic(api_key=api_key)
response = client.messages.create(
    model="claude-opus-4-5",
    tools=TOOLS,
    ...
)
```

The `tool_use` / `tool_result` message format is Anthropic-specific.
While `llm_service.py` supports Groq and Ollama for conversational
queries, neither can participate in the tool-use loop — Groq uses a
different JSON schema for tool calls, and Ollama's tool support varies
by model.

### MCP: open protocol, any compatible client

MCP is a published open protocol (modelcontextprotocol.io). Any client
that implements it can use `mcp_server.py` without modification:

- Claude Desktop (Anthropic)
- Claude Code (this CLI)
- Any future client that adopts the protocol
- Custom Python clients using the `mcp` SDK

The server does not know or care which model is on the other end.
It speaks JSON-RPC over stdio — if the client speaks the same protocol,
it works.

### Impact

| Dimension | Tool Use API | MCP |
|---|---|---|
| LLM for tool loop | Anthropic only | Any MCP-compatible client |
| Protocol | Anthropic proprietary `tool_use` format | Open JSON-RPC standard |
| Portability | Cannot reuse tools with other providers | Tools work with any MCP client |
| Vendor lock-in | Yes — SDK + message format | No — protocol is open |

---

## 4. Human-in-the-Loop — How Each Approach Handles It

### Tool Use API: hard enforcement at the application layer

The application controls the loop, so it can intercept at any point.
After Claude calls `summarise_plan_for_human`, the loop exits and returns
`{"status": "awaiting_approval"}` to the FastAPI endpoint. The plan is
written to disk. Nothing happens until the user explicitly calls
`POST /agent/approve/{execution_id}` with `approved=True`.

```python
# agent_service.py — loop exits after summary
return {
    "status": "awaiting_approval",
    "execution_id": execution_id,
    "summary": collected_summary,
    ...
}
# approve_and_apply() is only called from a separate HTTP endpoint
# that requires the user to POST with approved=True
```

The human gate is **architecturally enforced**: `run_terraform_apply`
cannot be reached from the agent loop. Claude cannot bypass it.

### MCP: no built-in gate — trust must be designed in

An MCP server does not have a mechanism to pause mid-conversation and
wait for human input. If `run_terraform_apply` were registered as an MCP
tool, Claude could call it immediately after `validate_terraform_plan`
with no human checkpoint. The burden of safety shifts to:

1. **Not registering destructive tools** — `run_terraform_apply` is
   intentionally absent from `mcp_server.py` for this reason.
2. **System prompt instructions** — telling Claude in its system prompt
   never to apply changes without confirmation (soft constraint only).
3. **Client-side confirmation** — Claude Desktop will ask the user
   "Allow this tool call?" for each tool invocation. This is a UX
   gate, not a code gate — users can click "Allow always".

### Impact

| Dimension | Tool Use API | MCP |
|---|---|---|
| Approval enforcement | Hard — code path requires `approved=True` | Soft — client UX prompt only |
| Bypassing the gate | Impossible without code change | Possible if user clicks "Allow always" |
| Audit trail | `execution_log.json` records approval decision | No built-in audit log |
| Suitable for production | Yes, with proper IAM + approval flow | Only if destructive tools are excluded |

---

## 5. Code Complexity — Lines Removed vs Added

### Lines that can eventually be removed (Tool Use API boilerplate)

| Location | What | Lines |
|---|---|---|
| `terraform_service.py:11–85` | `TERRAFORM_TOOL`, `RUN_PLAN_TOOL`, `SUMMARISE_PLAN_TOOL` dicts + `TOOLS` list | ~75 |
| `terraform_service.py:491–512` | `dispatch_tool()` routing function | ~22 |
| `agent_service.py:127–190` | The entire `while iteration < MAX_ITERATIONS` loop body | ~64 |
| `agent_service.py:1–22` | Imports for `TOOLS` and `dispatch_tool` | ~5 |

**Reducible total: ~166 lines of orchestration logic**

Note: the handler functions (`handle_generate_terraform`,
`handle_run_terraform_plan`, `handle_summarise_plan`) stay — they become
the bodies of MCP tools rather than being called via dispatch.

### Lines added (MCP implementation)

| File | What | Lines |
|---|---|---|
| `backend/mcp_server.py` | Complete MCP server with 7 tools + 2 resources | ~449 |

Most of those lines are docstrings — the actual logic in each MCP tool is
2–6 lines (a function call and a return). The docstrings are the meaningful
addition: they are what Claude reads to understand what the tool does.

### Net assessment

The MCP approach does not reduce overall code volume significantly when
docstrings are included. What it eliminates is **coupling**: the dispatch
table, the schema dicts, and the loop that glues them together. Each tool
is now self-contained — its schema, its logic, and its documentation live
in one function.

---

## 6. When to Choose Each Approach

### Choose the Tool Use API when:

- **You need a hard human-in-the-loop gate.** If a wrong tool call can
  delete production infrastructure, you cannot rely on a UX prompt.
  The Tool Use API lets you enforce approval in code.

- **You need per-request credential isolation.** If different users supply
  different AWS keys in each request, the Tool Use API can thread
  credentials through every call. MCP servers have one credential context
  for their lifetime.

- **You are building a tightly-coupled pipeline.** If the tool sequence is
  deterministic (always: scan → analyse → plan → summarise → await approval),
  owning the loop makes the pipeline explicit and auditable.

- **You cannot install Claude Desktop.** The Tool Use API works in any
  Python environment with an Anthropic API key. MCP requires a compatible
  client.

- **You need fine-grained token and cost control.** Because you own the
  loop, you control exactly how many API calls are made, what goes into
  each prompt, and when to stop.

### Choose MCP when:

- **You want tools to be reusable across projects.** Once in `mcp_server.py`,
  the same scan and analysis tools can be used from Claude Desktop, Claude
  Code, CI pipelines, or any future MCP client.

- **You want Claude to decide the tool sequence.** If the right order of
  tool calls depends on what the data says (e.g. only scan IAM if EC2 looks
  suspicious), Claude is better at this than a hardcoded loop.

- **You are building for a single trusted user.** Claude Desktop's
  per-tool confirmation dialogs provide sufficient safety for a developer
  working on their own AWS account.

- **You want zero dispatch boilerplate.** Decorator-based registration means
  adding a new capability is one annotated function, not a three-file change.

- **You are prototyping or exploring.** MCP tools are immediately usable
  from Claude Desktop without any application code. "Add a tool, restart
  the server, use it" is a faster iteration cycle than modifying an agent
  loop.

---

## Dissertation Framing

The Tool Use API implementation — the manual `TOOLS` dict, `dispatch_tool()`
routing function, and `while iteration < MAX_ITERATIONS` agentic loop in
`agent_service.py` — represents a deeper and more academically rigorous
contribution than the MCP layer added on top of it. Building these
primitives by hand demonstrates a precise understanding of how an LLM
decides when to call a tool, how structured outputs are formatted and
returned, and how conversation state is maintained across multiple API
turns — all concepts that FastMCP abstracts away behind a decorator. The
MCP implementation is best framed not as a replacement but as a validation:
having built the underlying mechanics manually, the project then shows that
those same mechanics can be expressed through a standardised protocol,
proving that the hand-rolled approach was architecturally sound and
protocol-compatible from the start.
