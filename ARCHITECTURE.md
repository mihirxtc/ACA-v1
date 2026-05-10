# Agentic Cloud Assistant — Architecture

## System Overview

ACA is an AI-powered AWS infrastructure management tool. The user interacts with a React frontend that communicates exclusively through the **Model Context Protocol (MCP)** over HTTP to a Python backend. The backend exposes every capability as an MCP tool, which means the same interface works for the browser UI, Claude Desktop, and the Claude Code CLI simultaneously.

---

## Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser / User                           │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP (port 80 in Docker, 5173 in dev)
┌────────────────────────────▼────────────────────────────────────┐
│                      Nginx (frontend container)                 │
│  Serves React SPA                                               │
│  Reverse-proxies: /mcp  /tools  /rag  /terraform  /health       │
└──────┬──────────────────────────────────────────────────────────┘
       │ proxy_pass → backend:8000
┌──────▼──────────────────────────────────────────────────────────┐
│                    FastAPI  (main.py)  :8000                     │
│                                                                 │
│  GET  /health           — uptime check                          │
│  POST /rag/documents/upload — multipart PDF/text ingest         │
│  GET  /terraform/keys/{id}/{file} — .pem private key download   │
│  POST /tools/{name}     — auto-generated Swagger test routes    │
│  POST /mcp/*            — mounted FastMCP app (all tool calls)  │
└──────┬──────────────────────────────────────────────────────────┘
       │ in-process mount
┌──────▼──────────────────────────────────────────────────────────┐
│                  FastMCP Server  (mcp_server.py)                 │
│                                                                 │
│  Defines 30+ @mcp.tool() functions across 6 groups:            │
│   A. AWS Scanning      (full_aws_scan, scan_ec2, scan_s3 …)     │
│   B. Security          (analyse_security_findings, agent_run …) │
│   C. Cost              (estimate_costs, get_cost_with_summary)  │
│   D. Terraform         (generate_terraform_from_request, plan…) │
│   E. Chat              (aws_chat)                               │
│   F. RAG               (rag_query_tool, rag_add_text_document…) │
│                                                                 │
│  MCP Resources:  aws://findings/{region}                        │
│                  aws://cost-summary/{region}                    │
└──────┬──────────────────────────────────────────────────────────┘
       │ direct Python calls
┌──────▼──────────────────────────────────────────────────────────┐
│                       Services Layer                            │
│                                                                 │
│  aws_scanner.py       ──► boto3 ──► AWS APIs (EC2/S3/IAM/SG/VPC)│
│  security_analyzer.py ──► 7-rule engine, returns findings       │
│  cost_analyzer.py     ──► boto3 ──► AWS Cost Explorer           │
│  terraform_service.py ──► LLM (tool-use) ──► HCL string         │
│                           subprocess ──► terraform validate      │
│  execution_service.py ──► subprocess ──► terraform init/plan    │
│                                          terraform apply/destroy │
│                           filesystem ──► terraform_workdirs/     │
│                           filelock   ──► execution_log.json      │
│  llm_service.py       ──► httpx ──► Groq API  (llama-3.3-70b)  │
│                           httpx ──► Anthropic API (claude-haiku) │
│                           httpx ──► Ollama local  (gpt-oss)     │
└──────┬──────────────────────────────────────────────────────────┘
       │ direct Python calls
┌──────▼──────────────────────────────────────────────────────────┐
│                        RAG Layer  (rag/)                        │
│                                                                 │
│  knowledge_base.py  ──► ChromaDB (chroma_db/ volume)           │
│                         SentenceTransformer (all-MiniLM-L6-v2) │
│  rag_service.py     ──► vector search ──► augmented prompt      │
│                         ──► llm_service.prompt_llm() ──► answer │
│  seed_knowledge.py  ──► one-time bulk insert of AWS docs        │
└─────────────────────────────────────────────────────────────────┘
```

---

## How Components Talk to Each Other

### 1. Browser → Backend (every action)

Every panel button in the React UI calls `callTool(name, args)` from `src/api/mcpClient.js`. This sends a single JSON-RPC 2.0 POST to `/mcp`:

```
POST /mcp
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "full_aws_scan", "arguments": { "region": "us-east-1" } } }
```

The client also sends an `initialize` handshake on first use and tracks a `Mcp-Session-Id` header for session continuity. In Docker, Nginx forwards this to `backend:8000/mcp`. In local dev, the Vite proxy forwards it to `localhost:8000`.

### 2. Nginx → Backend (Docker only)

Nginx routes by URL prefix:

| Prefix | Destination | Purpose |
|---|---|---|
| `/mcp` | `backend:8000/mcp` | All MCP tool calls — SSE streaming, no buffering |
| `/rag/` | `backend:8000/rag/` | Multipart file uploads to knowledge base |
| `/terraform/` | `backend:8000/terraform/` | `.pem` private key file downloads |
| `/tools/` | `backend:8000/tools/` | Swagger-documented REST test endpoints |
| `/health` | `backend:8000/health` | Docker healthcheck |
| `/` | React SPA (`index.html`) | Client-side routing fallback |

Timeout is set to 300 s on all backend routes to handle long-running `terraform plan/apply` operations.

### 3. FastAPI → FastMCP (in-process)

`main.py` mounts the FastMCP Starlette app at `/mcp` using `mcp.http_app()`. No HTTP hop — it is a direct in-process function call. `docs_generator.py` reads FastMCP's internal component registry at startup and creates a mirrored `POST /tools/{name}` FastAPI route for every `@mcp.tool()`, giving Swagger UI a live testable endpoint for each tool.

### 4. MCP Tools → Services (direct Python import)

`mcp_server.py` imports directly from `services/`. Each tool function is a thin orchestration layer — it resolves credentials and model keys, calls the relevant service functions, and returns a dict. No HTTP between tools and services.

**Key orchestration pattern — `agent_run`:**
1. Calls `aws_scanner` functions → raw scan data
2. Passes scan data to `security_analyzer.run_security_analysis()` → findings list
3. Takes top finding, builds a fix request string
4. Calls `terraform_service.generate_terraform()` → HCL string
5. Calls `execution_service.run_terraform_plan()` (in a thread) → plan output + execution ID
6. Calls `llm_service.prompt_llm()` → plain-English summary
7. Returns everything to the frontend in one response, awaiting human approval

**Key optimisation — `aws_chat`:**
Scan results are cached in a `TTLCache` (5-minute TTL, keyed by region). Follow-up chat messages reuse the cached scan data instead of re-calling all 9 AWS APIs on every message.

### 5. Services → AWS (boto3)

`aws_scanner.py` and `cost_analyzer.py` use `boto3`. Each request builds its own `boto3.Session` from the credentials passed in the tool call arguments (access key + secret key + region). If no credentials are passed, boto3 falls back to the environment variables set in the backend's `.env` file. This means the app supports two credential modes: env-based (server-side keys in `.env`) and pass-through (user supplies keys in the UI, forwarded as tool arguments).

### 6. Services → LLMs (httpx)

`llm_service.py` talks to all three LLM providers over HTTPS using `httpx.AsyncClient`:

| Provider | Endpoint | Model | Used for |
|---|---|---|---|
| Groq | `api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` | Default — fast, free tier |
| Anthropic | `api.anthropic.com/v1/messages` | `claude-haiku-4-5` | Optional — higher quality |
| Ollama | `localhost:11434/api/chat` | `gpt-oss:120b-cloud` | Local — no data leaves machine |

`terraform_service.py` uses a different pattern — it calls the Anthropic and Groq Python SDKs with `tool_choice={"type":"tool","name":"generate_terraform"}` to force structured JSON output for HCL generation.

### 7. Services → Terraform CLI (subprocess)

`execution_service.py` runs Terraform as a subprocess:

```
terraform init  -backend=false  (downloads providers, ~200 MB)
terraform plan  -out=tfplan     (read-only, saves binary plan)
terraform apply -auto-approve tfplan  (applies the exact saved plan)
terraform destroy -auto-approve       (rollback path)
```

Each execution gets its own isolated directory under `terraform_workdirs/{execution_id}/`. After apply, `.terraform/` (provider cache) and `tfplan` are deleted to save space. `main.tf` and any `.pem` key files are kept for audit trail and download.

### 8. RAG → ChromaDB (in-process)

`rag/knowledge_base.py` holds a persistent `chromadb.PersistentClient` pointed at the `chroma_db/` directory (mounted as a Docker volume). Documents are chunked (500 chars, 50-char overlap) and embedded using `sentence-transformers/all-MiniLM-L6-v2` locally — no external embedding API needed. `rag_service.py` queries ChromaDB for the top-N chunks above a relevance threshold of 0.3, builds an augmented prompt with the retrieved context, then calls `llm_service.prompt_llm()` to generate a grounded answer.

### 9. Claude Desktop / Claude Code → Backend (MCP protocol)

The same `POST /mcp` endpoint that the browser uses is also a valid MCP HTTP server for AI clients:

- **Claude Code CLI**: add `{ "url": "http://localhost:8000/mcp" }` to MCP config — all 30+ tools become available as slash commands
- **Claude Desktop**: run `python mcp_server.py --stdio` (stdio transport mode) — Claude Desktop spawns the server as a subprocess and communicates over stdin/stdout

---

## Data Flow: Security Remediation (end-to-end)

```
User clicks "Run Agent"
  │
  ▼
mcpClient.callTool("agent_run", { region, model, api_key, aws_creds })
  │  JSON-RPC POST /mcp
  ▼
mcp_server.agent_run()
  ├─► aws_scanner: scan_ec2/s3/iam/sg/vpc  ──► AWS API (boto3)
  ├─► security_analyzer.run_security_analysis()  ──► findings[]
  ├─► terraform_service.generate_terraform()  ──► LLM (Groq/Anthropic)  ──► HCL
  ├─► execution_service.run_terraform_plan()  ──► terraform init + plan
  └─► llm_service.prompt_llm()  ──► LLM  ──► plain-English summary
  │
  │  Returns: { execution_id, issue, hcl, plan_output, summary }
  ▼
Frontend shows plan + summary to user
  │
  │ User clicks "Approve"
  ▼
mcpClient.callTool("run_terraform_apply_mcp", { execution_id, approved: true })
  │
  ▼
execution_service.run_terraform_apply()  ──► terraform apply tfplan
  │                                          writes .pem if key pair created
  │  Returns: { status, apply_output, key_files: [{ name, download_path }] }
  ▼
Frontend shows "Download .pem" button
  │
  │ User clicks download
  ▼
fetch(file.download_path)  ──► GET /terraform/keys/{id}/{name}
  │
  ▼
execution_service.get_key_file()  ──► reads .pem from workdir  ──► bytes
  │
  ▼
Browser saves kaivalya-key.pem  (real RSA private key)
```

---

## Storage

| Location | Type | Contents | Persistence |
|---|---|---|---|
| `backend/.env` | File | API keys, AWS credentials | Permanent (gitignored) |
| `backend/chroma_db/` | ChromaDB | Vector embeddings of knowledge base docs | Docker volume |
| `backend/terraform_workdirs/` | Filesystem | `main.tf`, `tfplan`, `.terraform/`, `.pem` files per execution | Docker volume |
| `backend/execution_log.json` | JSON array | Audit log of every plan/apply/rollback | In-container (not volumed) |

---

## Deployment Modes

| Mode | Command | Frontend | Backend |
|---|---|---|---|
| **Docker (production)** | `docker-compose up` | Nginx on :80, serves built React SPA | uvicorn on :8000 (internal only) |
| **Local dev** | `uvicorn main:app --reload` + `npm run dev` | Vite on :5173 (proxies /mcp /terraform /rag to :8000) | uvicorn on :8000 with hot reload |
| **MCP stdio** | `python mcp_server.py --stdio` | — | Reads/writes stdin/stdout for Claude Desktop |
