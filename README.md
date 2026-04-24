# Agentic Cloud Assistant

An autonomous AWS infrastructure management tool that scans your cloud environment, identifies security risks, monitors costs, generates Terraform remediation code, and executes fixes with a human-in-the-loop approval gate — all through a conversational web interface.

---

## Architecture

The backend is a **FastAPI** application (Python) that exposes a REST API consumed by a **React + Vite** single-page frontend. Infrastructure data is collected live at request time via **AWS boto3** across five services (EC2, S3, IAM, security groups, VPCs) with no local caching between requests. Security analysis and Terraform HCL generation use **Anthropic's MCP tool-use pattern** — the LLM drives an agentic loop that calls structured tools (generate, plan, summarise) and halts at a human approval gate before any change is applied to AWS. All three major LLM providers are supported: Groq (default), Anthropic, and Ollama for fully local inference.

---

## Features

- **AWS infrastructure scanning** — EC2, S3, IAM, security groups, and VPCs in a single request
- **Security analysis** — 7-rule engine (open ports, public buckets, MFA gaps, root account usage, over-permissive IAM, and more) with LLM-generated plain-English summary and a 0–100 health score
- **Cost monitoring** — current month spend, 3-month trend, per-service breakdown, anomaly detection (20%+ spike), and LLM optimisation recommendations
- **Terraform HCL generation** — describe any AWS resource in plain English and receive validated, ready-to-apply HCL with `terraform validate` run automatically
- **Human-in-the-loop execution** — `terraform plan` runs first and displays a full diff; `terraform apply` fires only on explicit user approval
- **Agentic remediation loop** — autonomous agent identifies the highest-priority security issue, generates a Terraform fix, plans it, and presents a human-readable summary for sign-off
- **Infrastructure chat** — ask questions about your live AWS environment in plain English; the LLM receives a fresh scan on every message
- **Execution history** — persistent log of every plan/apply action with timestamps, status, and terminal output

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Python 3.10+ | Backend runtime |
| Node.js 18+ | Frontend build tooling |
| Terraform CLI 1.x | Must be on `$PATH` — `terraform --version` to verify |
| AWS account | Programmatic access key + secret key required |
| LLM API key | Groq (free tier sufficient) **or** Anthropic |

---

## Backend Setup

```bash
cd backend

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt

# Copy the example env file and add your real keys
cp .env.example .env
nano .env   # or open in any editor

# Start the API server (auto-reloads on file changes)
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.

---

## Frontend Setup

```bash
cd frontend

# Install Node dependencies
npm install

# Start the Vite development server
npm run dev
```

The UI will be available at `http://localhost:5173`.

---

## First Run

1. Open `http://localhost:5173` in your browser.
2. Log in with the demo credentials — **username:** `admin` **password:** `demo2024`.
3. Click the **API Keys** button in the top-right of the dashboard.
4. On the **Cloud Credentials** tab, enter your AWS Access Key ID, Secret Access Key, and preferred region.
5. On the **LLM Settings** tab, enter your Groq or Anthropic API key and select a model.
6. Close the settings panel and click **Scan** on the Infrastructure panel — all five AWS scanners will run and populate the dashboard.

> **Security note:** The `admin / demo2024` credentials are hardcoded in the React frontend for local development convenience only. Do not expose this application to the public internet without replacing the authentication layer with a proper identity provider.

---

## API Reference

Interactive Swagger docs (with a try-it-out UI for every endpoint) are available at **`http://localhost:8000/docs`** while the server is running.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server liveness check — returns status and version |
| `GET` | `/aws/ec2` | List EC2 instances using ambient server credentials |
| `GET` | `/scan` | Full infrastructure scan — EC2, S3, IAM, security groups, VPCs |
| `POST` | `/chat` | Chat with an LLM that has live AWS context injected into every message |
| `GET` | `/security` | Security rule engine + LLM summary + 0–100 health score |
| `GET` | `/cost` | Cost Explorer data, trend analysis, and LLM optimisation recommendations |
| `POST` | `/terraform/generate` | Generate validated Terraform HCL from a plain-English description |
| `POST` | `/terraform/plan` | Run `terraform plan` on provided HCL and return the diff output |
| `POST` | `/terraform/apply` | Apply a previously planned change (requires `approved: true` in body) |
| `GET` | `/terraform/executions` | Retrieve full plan/apply execution history |
| `POST` | `/agent/run` | Start the agentic security remediation loop (scan → generate → plan) |
| `POST` | `/agent/approve/{id}` | Human approval gate — approve or reject a pending agent execution |
| `GET` | `/agent/status/{id}` | Check the current status of a specific agent execution |

---

## Project Structure

```
agentic-cloud-assistant-dev/
│
├── README.md
│
├── backend/
│   ├── main.py                      # FastAPI app — all route handlers and Pydantic models
│   ├── agent_service.py             # Agentic loop orchestration (scan → plan → await approval)
│   ├── benchmark.py                 # Endpoint latency benchmarking script (dissertation eval)
│   ├── requirements.txt             # Python dependencies
│   ├── .env.example                 # Environment variable template (copy to .env)
│   ├── .env                         # Your local secrets — never committed to git
│   ├── execution_log.json           # Persistent Terraform execution history
│   └── services/
│       ├── aws_scanner.py           # boto3 calls — EC2, S3, IAM, security groups, VPCs
│       ├── security_analyzer.py     # 7-rule security engine + LLM summary generation
│       ├── cost_analyzer.py         # Cost Explorer queries + anomaly detection + LLM insights
│       ├── terraform_service.py     # HCL generation tools + MCP tool definitions
│       ├── execution_service.py     # terraform plan/apply subprocess runner + execution log
│       └── llm_service.py           # Groq / Anthropic / Ollama client wrappers
│
└── frontend/
    ├── index.html                   # Vite HTML entry point
    ├── package.json                 # Node dependencies and scripts
    └── src/
        ├── App.jsx                  # Root component — provider tree, routing, toast config
        ├── main.jsx                 # ReactDOM entry point
        ├── index.css                # Global styles and skeleton-pulse animation keyframes
        ├── context/
        │   ├── ApiKeyContext.jsx    # Global credential state (AWS keys, LLM keys, region)
        │   └── AuthContext.jsx      # Login session state and logout handler
        └── components/
            ├── Dashboard.jsx        # Main layout — responsive 2×2 panel grid
            ├── LoginPage.jsx        # Authentication screen
            ├── ProtectedRoute.jsx   # Route guard — redirects to login if unauthenticated
            ├── SecurityPanel.jsx    # Security findings list + health score badge
            ├── CostPanel.jsx        # Cost breakdown, trend, anomaly alert
            ├── TerraformPanel.jsx   # HCL generator with copy and deploy buttons
            ├── ExecutionPanel.jsx   # Plan → approve → apply state machine UI
            ├── AgentPanel.jsx       # Agentic remediation loop UI (5-phase state machine)
            ├── Chat.jsx             # LLM chat interface with conversation memory
            ├── ExecutionLog.jsx     # Terraform execution history table
            └── ApiKeySettings.jsx   # Credential management modal (AWS + LLM tabs)
```
