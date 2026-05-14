# Agentic Cloud Assistant (ACA) — v2.0

An autonomous AWS infrastructure management tool that scans your cloud environment, identifies security risks, monitors costs, generates Terraform remediation code, and executes fixes with a human-in-the-loop approval gate — all through a conversational web interface.

---

## Architecture

The backend is a **FastMCP** server (Python) that exposes every capability as a typed MCP tool over a single `POST /mcp` endpoint (JSON-RPC 2.0 / streamable-HTTP transport). A **React + Vite** single-page frontend speaks directly to that endpoint via a thin JSON-RPC client — there are no legacy REST routes for business logic. A parallel `docs_generator` auto-registers every MCP tool as a Swagger-documented `POST /tools/{name}` endpoint for interactive testing at `/docs`.

Infrastructure data is collected live at request time via **AWS boto3** across six services (EC2, S3, IAM, security groups, VPCs, and security-group usage maps). Security analysis and Terraform HCL generation use an **agentic loop** driven by Anthropic's `claude-opus-4-5`, which calls MCP tools via a `FastMCP Client` and halts at a human approval gate before any change is applied to AWS. Three LLM providers are supported: Groq (default), Anthropic, and Ollama for fully local or cloud-model inference.

A **ChromaDB** vector store (backed by `sentence-transformers`) powers a RAG knowledge base that can be queried in plain English and enriched with custom PDF or text documents.

A **hybrid model recommender** (Phase 5) scores the three Ollama cloud models across four weighted features — task alignment, scan-size handling, latency fit, and recent usage patterns — and generates plain-English rationales via the configured LLM (with a deterministic template fallback when no key is present).

```
Browser → React UI → POST /mcp → FastMCP Server → MCP Tools → AWS / LLM / Terraform
                               └→ Claude Desktop (stdio mode)
                               └→ Claude Code (HTTP mode)
```

---

## Features

- **AWS infrastructure scanning** — EC2, S3, IAM, security groups, VPCs, and security-group usage maps (via ENIs, covering all resource types)
- **Security analysis** — 7-rule engine (open SSH/RDP ports, public S3 buckets, MFA gaps, root account usage, over-permissive IAM, and more) with severity-ranked findings (HIGH / MEDIUM / LOW) and a 0–100 health score
- **Direct security fixes** — one-click `revoke_open_ingress_rule` removes 0.0.0.0/0 rules for SSH (port 22) and RDP (port 3389) without generating Terraform
- **Cost monitoring** — current month spend, 3-month trend, per-service breakdown, anomaly detection (20%+ spike), and LLM optimisation recommendations
- **Terraform HCL generation** — describe any AWS resource in plain English; the LLM scans existing infra first to reference real VPC / SG / subnet IDs and avoid conflicts
- **Terraform syntax validation** — `terraform validate` runs automatically after generation
- **Human-in-the-loop execution** — `terraform plan` runs first and displays a full diff; `terraform apply` fires only on explicit user approval
- **Terraform rollback** — `terraform destroy` on the saved plan for any completed execution
- **PEM key download** — EC2 instances created with a new key pair generate a downloadable `.pem` file served at `/terraform/keys/{id}/{filename}`
- **Agentic security remediation** — autonomous agent (Anthropic claude-opus-4-5) scans AWS, picks the highest-severity finding, generates a Terraform fix via MCP tools, plans it, and presents a plain-English summary for sign-off
- **Mark resolved** — flag any finding execution as resolved in the audit log without deleting it
- **Infrastructure chat** — ask questions about your live AWS environment in plain English; each message triggers a full 9-source scan (EC2, S3, IAM, SGs, VPCs, SG usage, cost data) for accurate context
- **RAG knowledge base** — semantic search over custom security documentation; add plain-text or PDF files and ask questions grounded by retrieved chunks
- **Execution history** — persistent, file-locked JSON log of every plan/apply/destroy action with timestamps, status, and terminal output
- **Auto-refresh** — dashboard re-scans infrastructure every 90 seconds after the first manual scan
- **Claude Desktop & Claude Code integration** — the MCP server runs in stdio mode (Claude Desktop) or HTTP mode (Claude Code / any MCP-compatible client)
- **Ollama integration** — run models fully locally or pull cloud models (`gpt-oss:20b-cloud`, `gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`) via the Ollama runtime with one-click install and auth-state detection
- **Model recommender** — hybrid rule-based + LLM scorer that ranks the three cloud models by task fit, scan size, latency preference, and recent usage history; surfaces ranked cards with install-progress UI in the Settings panel

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Python 3.10+ | Backend runtime |
| Node.js 18+ | Frontend build tooling |
| Terraform CLI 1.x | Must be on `$PATH` — verify with `terraform --version` |
| AWS account | Programmatic access key + secret key required |
| LLM API key | Groq (free tier sufficient) **or** Anthropic — **or** Ollama for local inference |

---

## Backend Setup

```bash
cd backend

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt

# Copy the example env file and fill in your keys
cp .env.example .env
nano .env

# Start the MCP server (auto-reloads on file changes)
uvicorn main:app --reload --port 8000
```

The server starts two interfaces:

| Interface | URL | Purpose |
|---|---|---|
| MCP endpoint | `POST http://localhost:8000/mcp` | Primary — used by the React frontend and MCP clients |
| Swagger UI | `http://localhost:8000/docs` | Auto-generated test UI for every MCP tool |
| Key download | `GET http://localhost:8000/terraform/keys/{id}/{file}` | Binary PEM file download |
| Ollama status | `GET http://localhost:8000/api/ollama/status` | Probe local Ollama instance |
| Ollama pull | `POST http://localhost:8000/api/ollama/pull` | Stream model pull progress (NDJSON) |
| Model recommend | `POST http://localhost:8000/api/ollama/recommend` | Ranked model recommendations with LLM rationales |
| Usage summary | `GET http://localhost:8000/api/usage/summary` | Rolling 24-hour action and scan-size aggregates |

---

## Frontend Setup

```bash
cd frontend

npm install
npm run dev
```

The UI will be available at `http://localhost:5173`.

The frontend communicates **exclusively** via `POST /mcp` for infrastructure operations — there are no separate REST calls for business logic. The MCP client in `src/api/mcpClient.js` handles session initialisation, SSE streaming, and JSON-RPC framing automatically. The Ollama and recommender routes (`/api/*`) are thin REST helpers served alongside the MCP endpoint.

---

## Docker Deployment

A `docker-compose.yml` is included for a single-command production-like deployment. Nginx proxies `/mcp` and `/rag/` to the backend; the frontend is served on port 80.

```bash
# Copy and fill in backend/.env first, then:
docker compose up --build
```

The UI will be available at `http://localhost`. ChromaDB data and Terraform working directories are persisted in named Docker volumes (`chroma_data`, `terraform_workdirs`).

---

## Claude Desktop & Claude Code Integration

The MCP server can be connected directly to Claude Desktop or Claude Code without the React UI.

### Claude Code (HTTP transport)

Start the server, then add it to your MCP config:

```bash
# Start the server
cd backend && python mcp_server.py

# Add to Claude Code (or edit ~/.claude/claude_code_config.json)
# URL: http://localhost:8000/mcp   type: streamable-http
```

### Claude Desktop (stdio transport)

Claude Desktop launches the server as a subprocess — no manual start needed:

```json
{
  "mcpServers": {
    "agentic-cloud-assistant": {
      "command": "/absolute/path/to/ACA-MCP/.venv/bin/python",
      "args": ["/absolute/path/to/ACA-MCP/backend/mcp_server.py", "--stdio"],
      "env": {
        "PYTHONPATH": "/absolute/path/to/ACA-MCP/backend",
        "AWS_ACCESS_KEY_ID": "your-key-id",
        "AWS_SECRET_ACCESS_KEY": "your-secret",
        "AWS_DEFAULT_REGION": "us-east-1",
        "GROQ_API_KEY": "your-groq-key",
        "ANTHROPIC_API_KEY": "your-anthropic-key"
      }
    }
  }
}
```

See `claude_desktop_config_example.json` for the full template.

---

## First Run

1. Open `http://localhost:5173` in your browser.
2. Log in — **username:** `admin` **password:** `demo2024`.
3. Click the **Settings** button in the top-right to open the settings modal.
4. On the **Cloud Credentials** tab, enter your AWS Access Key ID, Secret Access Key, and preferred region.
5. On the **LLM Settings** tab, enter your Groq or Anthropic API key and select a model.
   - To use Ollama, select **Ollama** as the provider. If no model is installed the recommender will guide you through selection and one-click pull.
6. Close the settings panel and click **Scan** on the Infrastructure panel — all five AWS scanners will run and populate the dashboard.
7. Click **Analyse** on the Security panel to run the 7-rule engine and generate an LLM summary.

> **Security note:** The `admin / demo2024` credentials are hardcoded in the React frontend for local development convenience only. Do not expose this application to the public internet without replacing the authentication layer with a proper identity provider.

---

## Model Recommender

When Ollama is selected as the LLM provider, the Settings panel runs a two-question onboarding wizard:

| Question | Options |
|---|---|
| Primary use | General AWS chat · Security audits & compliance · Terraform / IaC generation · Autonomous agent tasks |
| Latency preference | Speed (fast responses) · Balanced · Quality (I'll wait for better answers) |

Answers are persisted in `localStorage` and sent to `POST /api/ollama/recommend`. The backend scores the three cloud models using a weighted formula:

| Feature | Weight | What it measures |
|---|---|---|
| Task fit | 40% | How well the model handles the declared primary use |
| Scan size fit | 25% | Model suitability for the current infra scan volume (none / small / medium / large) |
| Latency fit | 20% | Alignment with the stated speed preference |
| Recency boost | 15% | Affinity with the dominant action type in the rolling 24-hour usage log |

The recency weight scales down linearly when fewer than 3 events are recorded (redistributed equally to the other three features). Scores are deterministic and auditable — all weight tables are top-level constants in `backend/ollama_recommender.py` and `frontend/src/lib/ollamaCatalog.js`.

A natural-language rationale is generated for each ranked model via the configured LLM (Anthropic Haiku or Groq llama3-8b), with a template-based fallback when no key is present. Rationales are cached in-process by `(model_id, primary_use, latency_pref, scan_size_bucket)`.

The UI renders a **RecommendationCard** per model (rank badge, score, feature breakdown, explanation) with an inline install button that streams pull progress from Ollama. Auth errors from Ollama cloud models surface a clear `ollama signin` prompt instead of raw error text.

The frontend also implements a full client-side scoring fallback using the mirrored scoring tables in `src/lib/ollamaCatalog.js` and local usage history from `localStorage`, so recommendations work even when the backend is unreachable.

---

## Usage Event Log

Every LLM-backed action appends a structured event to `backend/data/usage_events.jsonl`:

```json
{"timestamp": "2026-05-14T10:23:01+00:00", "action_type": "security_analysis", "model_used": "gpt-oss:120b-cloud", "scan_size_bucket": "medium"}
```

| Field | Values |
|---|---|
| `action_type` | `chat` · `security_analysis` · `cost_recommendation` · `terraform_generation` · `agent_run` |
| `scan_size_bucket` | `none` · `small` (<5 resources) · `medium` (5–25) · `large` (>25) |

The rolling summary is exposed at `GET /api/usage/summary?window_hours=24` and used as the recency signal in the recommender. The frontend mirrors this in `localStorage` (capped at 20 events) via `src/lib/usageLog.js`.

---

## MCP Tool Reference

All tools are callable via `POST /mcp` (JSON-RPC `tools/call`) or the Swagger UI at `/docs`.

### Group A — AWS Scanning

| Tool | Description |
|---|---|
| `health_check` | Returns server status and confirms MCP connection |
| `full_aws_scan` | Runs all five scanners (EC2, S3, IAM, SGs, VPCs) in sequence |
| `scan_ec2_instances` | EC2 instances with state, IPs, and attached security group IDs |
| `scan_s3_buckets` | S3 buckets with public-access status |
| `scan_iam_users` | IAM users with MFA status and last-login date |
| `scan_security_groups_detail` | Security groups flagged for dangerous internet-facing rules |
| `scan_vpc_detail` | VPCs with CIDR, default flag, and subnet count |
| `scan_sg_usage_tool` | Maps every SG to attached resources (EC2, RDS, ALB, Lambda, ECS, ElastiCache) via ENIs; identifies unused SGs |

### Group B — Security & Cost

| Tool | Description |
|---|---|
| `analyse_security_findings` | Runs 7 built-in rules against a pre-fetched scan dict |
| `run_security_analysis_with_summary` | Full scan + rules + LLM plain-English summary in one call |
| `estimate_costs` | Cost Explorer data: current month, 3-month trend, per-service, anomaly |
| `get_cost_with_summary` | Cost data + LLM optimisation recommendations in one call |

### Group C — Terraform

| Tool | Description |
|---|---|
| `generate_terraform_hcl` | Generate HCL from a resource type + config dict |
| `generate_terraform_from_request` | Generate HCL from plain English; scans existing infra for context first |
| `validate_terraform_plan` | Validate HCL syntax via `terraform validate` without touching AWS |
| `run_terraform_plan_mcp` | Write HCL to a working dir, run `terraform init + plan`, return diff and execution ID |
| `run_terraform_apply_mcp` | Apply or reject a previously planned execution (human gate: `approved: bool`) |
| `run_terraform_destroy_mcp` | Destroy resources from a previous apply (rollback) |
| `get_execution_history_tool` | Return all plan/apply/destroy records from the execution log |
| `summarise_plan_for_human` | Parse raw plan output into a plain-English approval summary |

### Group D — Chat & Agent

| Tool | Description |
|---|---|
| `aws_chat` | Chat with an LLM about live AWS state; injects a 9-source scan as context |
| `agent_run` | Autonomous agent: scan → pick top finding → generate fix → plan → summarise |
| `agent_approve` | Human approval gate for agent-generated plans |
| `revoke_open_ingress_rule` | Direct AWS SDK fix — removes all 0.0.0.0/0 rules for a given port on a SG |
| `mark_execution_resolved` | Mark a finding execution as resolved in the audit log (audit-safe, no deletion) |
| `rollback_execution` | Run `terraform destroy` on a completed execution's saved plan |

### Group E — RAG Knowledge Base

| Tool | Description |
|---|---|
| `rag_query_tool` | Semantic search over ChromaDB + LLM-grounded answer |
| `rag_list_documents` | List all documents and chunk counts in the knowledge base |
| `rag_add_text_document` | Add a raw text document to ChromaDB |
| `rag_upload_file` | Add a PDF or text file (base64-encoded) to ChromaDB; PDFs parsed with PyPDF2 |
| `rag_delete_document` | Delete a document and all its chunks |

### Group F — Ollama & Recommender

| Tool / Endpoint | Type | Description |
|---|---|---|
| `ollama_status` (MCP tool) | MCP | Probe a local Ollama instance; returns installed/available cloud models and sign-in state |
| `GET /api/ollama/status` | REST | Same probe over HTTP; used by the frontend settings panel |
| `POST /api/ollama/pull` | REST | Stream model pull progress as NDJSON; synthesises `auth_required` event on sign-in errors |
| `POST /api/ollama/recommend` | REST | Ranked model recommendations with feature breakdowns and LLM-generated rationales |
| `GET /api/usage/summary` | REST | Rolling usage aggregates (action counts, dominant action, dominant scan size) |

### MCP Resources (pulled on demand)

| URI | Description |
|---|---|
| `aws://findings/{region}` | Latest security findings for a region |
| `aws://cost-summary/{region}` | Latest cost summary for the account |

---

## Project Structure

```
ACA-DEV/
│
├── README.md
├── ARCHITECTURE.md
├── docker-compose.yml               # Production deployment (Nginx + backend + frontend)
├── claude_desktop_config_example.json  # Claude Desktop / Claude Code MCP config template
│
├── backend/
│   ├── main.py                      # FastAPI app — MCP server mount, REST helpers, Ollama/recommender routes
│   ├── mcp_server.py                # All MCP tools and resources (Groups A–F)
│   ├── ollama_catalog.py            # Cloud model catalog (IDs, labels, descriptions)
│   ├── ollama_recommender.py        # Hybrid scorer: rule-based weights + LLM explanation layer
│   ├── usage_log.py                 # Append-only JSONL event log + rolling summary aggregator
│   ├── docs_generator.py            # Auto-registers every MCP tool as a Swagger POST /tools/{name}
│   ├── benchmark.py                 # Endpoint latency benchmarking (dissertation evaluation)
│   ├── terraform_gen.py             # Standalone Terraform HCL generation helpers
│   ├── requirements.txt             # Python dependencies
│   ├── Dockerfile                   # Backend container
│   ├── .env.example                 # Environment variable template (copy to .env)
│   ├── .env                         # Local secrets — never committed
│   ├── execution_log.json           # Persistent Terraform execution history (file-locked)
│   ├── data/
│   │   └── usage_events.jsonl       # Append-only LLM action event log (auto-created)
│   └── services/
│       ├── aws_scanner.py           # boto3 — EC2, S3, IAM, SGs, VPCs, SG usage, direct revoke
│       ├── security_analyzer.py     # 7-rule security engine + severity scoring
│       ├── cost_analyzer.py         # Cost Explorer queries + anomaly detection
│       ├── terraform_service.py     # HCL generation, plan summarisation, syntax validation
│       ├── execution_service.py     # terraform plan/apply/destroy subprocess + file-locked log
│       ├── llm_service.py           # Groq / Anthropic / Ollama client wrappers
│       └── ollama_service.py        # Ollama probe, cloud-model catalog filtering, pull streaming
│
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── Dockerfile                   # Frontend container (Nginx)
│   ├── nginx.conf                   # Proxies /mcp and /rag/ to backend
│   └── src/
│       ├── App.jsx                  # Root component — provider tree, routing, settings modal
│       ├── main.jsx                 # ReactDOM entry point
│       ├── api/
│       │   └── mcpClient.js         # JSON-RPC MCP client with SSE, session, and retry handling
│       ├── contexts/
│       │   ├── ApiKeyContext.jsx    # Global credential state (AWS keys, LLM keys, region)
│       │   └── AuthContext.jsx      # Login session state and logout handler
│       ├── hooks/
│       │   └── useRecommendations.js  # Fetches ranked recommendations; falls back to client-side scorer
│       ├── lib/
│       │   ├── ollamaCatalog.js     # Mirrored scoring tables (TASK_FIT, SCAN_SIZE_FIT, LATENCY_FIT, WEIGHTS)
│       │   └── usageLog.js          # localStorage-backed usage event log + summary (frontend mirror)
│       ├── utils/
│       │   ├── scoring.js           # Security health score (0–100) from findings
│       │   └── constants.js         # Shared constants (agent step labels, resource type list)
│       └── components/
│           ├── Dashboard.jsx        # Main layout — panel grid, scan orchestration, auto-refresh
│           ├── LoginPage.jsx        # Authentication screen
│           ├── SettingsModal.jsx    # AWS credentials + LLM settings + onboarding wizard + recommendation cards
│           ├── ui/
│           │   ├── Topbar.jsx       # Nav bar with health score badge and settings button
│           │   ├── ErrorBoundary.jsx
│           │   ├── Field.jsx
│           │   ├── Logo.jsx
│           │   └── DarkTooltip.jsx
│           └── panels/
│               ├── InfrastructurePanel.jsx   # EC2 / S3 / IAM / SG / VPC summary cards
│               ├── SecurityPanel.jsx         # Findings list, health score, direct-fix and Terraform-fix buttons
│               ├── CostPanel.jsx             # Cost breakdown, trend, anomaly alert
│               ├── ChatPanel.jsx             # LLM chat with conversation memory
│               ├── TerraformPanel.jsx        # HCL generator → plan → approve → apply state machine
│               ├── ExecutionHistoryPanel.jsx # Plan/apply/destroy history table with rollback
│               ├── SecurityAgentPanel.jsx    # Agentic remediation loop UI (5-phase state machine)
│               └── KnowledgeBasePanel.jsx    # RAG search, document upload/delete
│
└── chroma_db/                       # ChromaDB persistence directory (gitignored)
```
