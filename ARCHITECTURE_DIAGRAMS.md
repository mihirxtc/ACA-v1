# ACA-MCP Architecture Diagrams

**System:** Agentic Cloud Assistant (ACA-MCP)  
**Author:** Mihir Menon  
**Model:** C4 Architecture Model (Context → Container → Component → Code)

---

## Table of Contents

- [L1 — System Context](#l1--system-context)
- [L2 — Container Diagram](#l2--container-diagram)
- [L3 — Component Diagram](#l3--component-diagram)
- [L4 — Code Level](#l4--code-level)
  - [L4.1 Data Models](#l41--data-models)
  - [L4.2 Security Analyzer](#l42--security-analyzer)
  - [L4.3 Agent Service (Agentic Loop)](#l43--agent-service-agentic-loop)
  - [L4.4 LLM Service](#l44--llm-service)
  - [L4.5 Terraform Service](#l45--terraform-service)
- [C4 Level Summary](#c4-level-summary)

---

## L1 — System Context

> **Audience:** Executives, stakeholders  
> **Question:** What does the system do and who uses it?

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  SYSTEM CONTEXT DIAGRAM                                                      ║
║  System  : Agentic Cloud Assistant (ACA)                                     ║
║  Author  : Mihir Menon                                                       ║
╚══════════════════════════════════════════════════════════════════════════════╝

                          ┌─────────────────────┐
                          │      <<Person>>      │
                          │   Cloud Engineer     │
                          │                      │
                          │ Monitors and manages │
                          │ AWS infrastructure   │
                          └──────────┬───────────┘
                                     │
                       ┌─────────────┼─────────────┐
                       │             │             │
                  Uses Web UI   Uses Claude    Reviews
                  (browser)     Desktop/Code   Swagger docs
                       │             │             │
                       ▼             ▼             ▼
          ┌────────────────────────────────────────────────┐
          │                                                │
          │      ┌─────────────────────────────────┐       │
          │      │  <<Software System>>             │       │
          │      │  Agentic Cloud Assistant (ACA)   │       │
          │      │                                  │       │
          │      │  AI-powered AWS infrastructure   │       │
          │      │  management and remediation      │       │
          │      │  platform with MCP and REST APIs │       │
          │      └─────────────────────────────────┘       │
          │                    SYSTEM                       │
          └────────────────────────────────────────────────┘
                       │             │             │
          ┌────────────┘             │             └─────────────┐
          │                         │                           │
          ▼                         ▼                           ▼
┌──────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│  <<External      │    │  <<External System>> │    │  <<External        │
│    System>>      │    │  LLM Providers       │    │    System>>        │
│  Amazon Web      │    │                      │    │  Local Vector DB   │
│  Services (AWS)  │    │  - Groq (llama-3.3)  │    │                    │
│                  │    │  - Anthropic (Claude) │    │  ChromaDB          │
│  Reads resource  │    │  - Ollama (local)    │    │  Sentence-BERT     │
│  state, applies  │    │                      │    │  embeddings        │
│  Terraform plans │    │  AI reasoning and    │    │                    │
│                  │    │  code generation     │    │  RAG knowledge     │
└──────────────────┘    └──────────────────────┘    └────────────────────┘
```

---

## L2 — Container Diagram

> **Audience:** Architects, DevOps  
> **Question:** What are the deployable units and how do they connect?

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  CONTAINER DIAGRAM                                                           ║
║  System  : Agentic Cloud Assistant (ACA)                                     ║
║  Scope   : All running processes and storage                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

  USERS
  ─────
  [Cloud Engineer]                              [AI Agent (Claude)]


       │  HTTPS                                       │  MCP Protocol
       │  Browser                                     │  HTTP / stdio
       │                                              │
╔══════╪══════════════════════════════════════════════╪══════════════╗
║  DEPLOYMENT BOUNDARY  [localhost / dev server]      │              ║
║                                                     │              ║
║  ┌──────────────────────────────┐                   │              ║
║  │  <<Container>>               │                   │              ║
║  │  React Frontend              │                   │              ║
║  │  [Vite + React 19]           │                   │              ║
║  │  Port: 5173                  │                   │              ║
║  │                              │                   │              ║
║  │  Single-page application.    │                   │              ║
║  │  Dashboard, Chat, Security,  │                   │              ║
║  │  Cost, Terraform, RAG panels │                   │              ║
║  └──────────────┬───────────────┘                   │              ║
║                 │                                   │              ║
║                 │  JSON-RPC 2.0                     │              ║
║                 │  POST /mcp                        │              ║
║                 │  GET  /docs (Swagger)             │              ║
║                 │  REST (GET/POST/DELETE)            │              ║
║                 │                                   │              ║
║                 ▼                                   ▼              ║
║  ┌──────────────────────────────────────────────────────────────┐  ║
║  │  <<Container>>                                               │  ║
║  │  API + MCP Server                                            │  ║
║  │  [FastAPI + FastMCP + uvicorn]                               │  ║
║  │  Port: 8000                                                  │  ║
║  │                                                              │  ║
║  │  Dual-interface server. Exposes all capabilities as:         │  ║
║  │  (a) REST endpoints with OpenAPI/Swagger documentation       │  ║
║  │  (b) MCP tools and resources for AI agent consumption        │  ║
║  │                                                              │  ║
║  │  ┌──────────────────────┐  ┌─────────────────────────────┐   │  ║
║  │  │  REST API Layer      │  │  MCP Layer (mounted ASGI)   │   │  ║
║  │  │  [FastAPI Router]    │  │  [FastMCP / Streamable HTTP]│   │  ║
║  │  │                      │  │                             │   │  ║
║  │  │  18 REST endpoints   │  │  24 Tools  |  2 Resources   │   │  ║
║  │  │  /docs → Swagger UI  │  │  POST /mcp (JSON-RPC 2.0)   │   │  ║
║  │  └──────────┬───────────┘  └──────────────┬──────────────┘   │  ║
║  │             │                             │                   │  ║
║  │             └─────────────┬───────────────┘                   │  ║
║  │                           │                                   │  ║
║  │              ┌────────────▼────────────┐                      │  ║
║  │              │  Service / Domain Layer │                      │  ║
║  │              │  [Python modules]       │                      │  ║
║  │              │                         │                      │  ║
║  │              │  aws_scanner            │                      │  ║
║  │              │  security_analyzer      │                      │  ║
║  │              │  cost_analyzer          │                      │  ║
║  │              │  terraform_service      │                      │  ║
║  │              │  execution_service      │                      │  ║
║  │              │  llm_service            │                      │  ║
║  │              │  agent_service          │                      │  ║
║  │              │  rag_service            │                      │  ║
║  │              └────────────┬────────────┘                      │  ║
║  └───────────────────────────┼───────────────────────────────────┘  ║
║                              │                                       ║
║  ┌───────────────────────────▼───────────────────────────────────┐  ║
║  │  <<Container>>                                                 │  ║
║  │  Vector Database                                               │  ║
║  │  [ChromaDB  +  sentence-transformers]                          │  ║
║  │  Storage: ./chroma_db  (persistent local volume)              │  ║
║  │                                                                │  ║
║  │  Stores chunked, embedded AWS security documentation          │  ║
║  │  for retrieval-augmented generation (RAG) queries             │  ║
║  └───────────────────────────────────────────────────────────────┘  ║
║                                                                      ║
║  ┌───────────────────────────────────────────────────────────────┐  ║
║  │  <<Container>>                                                 │  ║
║  │  Execution Log                                                 │  ║
║  │  [JSON flat file — execution_log.json]                         │  ║
║  │                                                                │  ║
║  │  Persists Terraform plan/apply history and approval state      │  ║
║  └───────────────────────────────────────────────────────────────┘  ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
       │                     │                     │
       │  boto3              │  HTTPS              │  subprocess
       │  AWS SDK            │  REST API calls     │  CLI
       ▼                     ▼                     ▼
┌─────────────┐    ┌──────────────────────┐    ┌──────────────┐
│  Amazon Web │    │  LLM Providers       │    │  Terraform   │
│  Services   │    │                      │    │  CLI binary  │
│             │    │  api.groq.com        │    │              │
│  EC2        │    │  api.anthropic.com   │    │  plan        │
│  S3         │    │  localhost:11434     │    │  apply       │
│  IAM        │    │  (Ollama)            │    │  validate    │
│  VPC        │    │                      │    │              │
│  Cost Expl. │    │                      │    │              │
└─────────────┘    └──────────────────────┘    └──────────────┘
```

---

## L3 — Component Diagram

> **Audience:** Developers  
> **Question:** What are the major structural building blocks inside the main container?

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  COMPONENT DIAGRAM                                                           ║
║  Container : API + MCP Server  (main.py)                                     ║
║  Scope     : Internal components and their responsibilities                  ║
╚══════════════════════════════════════════════════════════════════════════════╝

  [React Frontend]              [Claude Code / Desktop]          [Browser]
        │                               │                            │
        │ JSON-RPC 2.0                  │ MCP Protocol               │ HTTP GET
        │ REST HTTP                     │ HTTP / stdio               │ /docs
        ▼                               ▼                            ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         CORS Middleware                                  │
  │               (allow: localhost:5173  |  expose: mcp-session-id)         │
  └───────────────────────────┬──────────────────────────────────────────────┘
                              │
              ┌───────────────┴────────────────┐
              │                                │
              ▼                                ▼
  ┌───────────────────────┐       ┌────────────────────────┐
  │  <<Component>>        │       │  <<Component>>          │
  │  REST API Controller  │       │  MCP Tool Registry      │
  │  [FastAPI Router]     │       │  [FastMCP + ASGI mount] │
  │                       │       │                         │
  │  Validates HTTP req.  │       │  Handles JSON-RPC 2.0   │
  │  Parses Pydantic      │       │  Dispatches tool calls  │
  │  models               │       │  Manages MCP sessions   │
  │  Returns HTTP resp.   │       │  Exposes resources      │
  │                       │       │                         │
  │  Generates /docs      │       │  tools/list →           │
  │  /redoc /openapi.json │       │   24 tool schemas       │
  └──────────┬────────────┘       └───────────┬─────────────┘
             │                                │
             └────────────────┬───────────────┘
                              │  both delegate to
                              ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                          Domain Services                                  │
  │                                                                           │
  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────────┐ │
  │  │ <<Component>>   │  │ <<Component>>   │  │ <<Component>>            │ │
  │  │ AWS Scanner     │  │ Security        │  │ Cost Analyzer            │ │
  │  │                 │  │ Analyzer        │  │                          │ │
  │  │ scan_ec2        │  │                 │  │ get_current_month_cost   │ │
  │  │ scan_s3         │  │ 7 built-in      │  │ get_monthly_trend        │ │
  │  │ scan_iam        │  │ security rules  │  │ detect_cost_anomaly      │ │
  │  │ scan_sg         │  │ HIGH/MED/LOW    │  │ get_cost_by_service      │ │
  │  │ scan_vpc        │  │ severity rating │  │                          │ │
  │  └────────┬────────┘  └────────┬────────┘  └────────────┬─────────────┘ │
  │           │                   │                         │               │
  │  ┌────────▼────────┐  ┌───────▼─────────┐  ┌───────────▼──────────────┐ │
  │  │ <<Component>>   │  │ <<Component>>   │  │ <<Component>>            │ │
  │  │ Terraform       │  │ Agent Service   │  │ RAG Service              │ │
  │  │ Service         │  │                 │  │                          │ │
  │  │                 │  │ Agentic loop:   │  │ query_knowledge_base     │ │
  │  │ generate_hcl    │  │  scan → analyse │  │ add_document             │ │
  │  │ validate_syntax │  │  → generate HCL │  │ ChromaDB read/write      │ │
  │  │ run_plan        │  │  → plan → await │  │ Embedding via            │ │
  │  │ run_apply       │  │  approval       │  │ sentence-transformers    │ │
  │  └─────────────────┘  └─────────────────┘  └──────────────────────────┘ │
  │                                                                           │
  │  ┌─────────────────────────────────────────────────────────────────────┐ │
  │  │  <<Component>>  LLM Service                                         │ │
  │  │                                                                     │ │
  │  │  chat_with_groq()  |  chat_with_anthropic()  |  chat_with_ollama() │ │
  │  │  Unified interface — route to any LLM provider transparently        │ │
  │  └─────────────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────────────┘
```

---

## L4 — Code Level

> **Audience:** Individual developers  
> **Question:** How is each component implemented — exact functions, signatures, call graphs?

---

### L4.1 — Data Models

> **File:** `backend/main.py` + `backend/services/security_analyzer.py`

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  L4 · DATA MODELS                                                            ║
╚══════════════════════════════════════════════════════════════════════════════╝

  ┌─────────────────────────────┐   ┌─────────────────────────────────────────┐
  │  <<Pydantic Model>>         │   │  <<Pydantic Model>>                     │
  │  ChatRequest                │   │  TerraformRequest                       │
  ├─────────────────────────────┤   ├─────────────────────────────────────────┤
  │ + message    : str          │   │ + request : str  (natural language)     │
  │ + model      : str = "groq" │   │ + model   : str = "groq"               │
  │ + history    : list = []    │   │ + api_key : str = ""                   │
  │ + api_key    : str = ""     │   └─────────────────────────────────────────┘
  └─────────────────────────────┘
                                     ┌─────────────────────────────────────────┐
  ┌─────────────────────────────┐   │  <<Pydantic Model>>                     │
  │  <<Pydantic Model>>         │   │  PlanRequest                            │
  │  ApplyRequest               │   ├─────────────────────────────────────────┤
  ├─────────────────────────────┤   │ + hcl_config   : str                   │
  │ + execution_id : str        │   │ + description  : str                   │
  │ + approved     : bool       │   └─────────────────────────────────────────┘
  └─────────────────────────────┘

  ┌─────────────────────────────┐   ┌─────────────────────────────────────────┐
  │  <<Pydantic Model>>         │   │  <<Pydantic Model>>                     │
  │  AgentRunRequest            │   │  ApprovalRequest                        │
  ├─────────────────────────────┤   ├─────────────────────────────────────────┤
  │ + anthropic_key      : str  │   │ + approved              : bool          │
  │ + aws_access_key_id  : str  │   │ + anthropic_key         : str           │
  │ + aws_secret_access_ : str  │   │ + aws_access_key_id     : str           │
  │   key                       │   │ + aws_secret_access_key : str           │
  │ + aws_region : str =        │   │ + aws_region  : str = "us-east-1"      │
  │               "us-east-1"  │   └─────────────────────────────────────────┘
  │ + issue_index : int = 0     │
  └─────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  <<Pydantic Model>>  RagQueryRequest                                    │
  ├─────────────────────────────────────────────────────────────────────────┤
  │ + question        : str                                                 │
  │ + resource_type   : Optional[str] = None                               │
  │ + n_results       : int = 3                                            │
  │ + groq_key        : Optional[str] = None                               │
  │ + anthropic_key   : Optional[str] = None                               │
  │ + model_provider  : str = "groq"                                       │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  <<Dict Schema>>  Security Finding  (make_finding → dict)               │
  │                   Used by all 7 rule functions, stored in execution log │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  finding_id    : str     e.g. "SSH_PORT_OPEN-sg-001-0"                 │
  │  resource_id   : str     e.g. "sg-0abc1234"                            │
  │  resource_type : str     EC2_SECURITY_GROUP | S3_BUCKET |              │
  │                          IAM_USER | VPC                                │
  │  rule          : str     SSH_PORT_OPEN | RDP_PORT_OPEN |               │
  │                          S3_BUCKET_PUBLIC | IAM_USER_NO_MFA |          │
  │                          UNRESTRICTED_ALL_TRAFFIC |                    │
  │                          IAM_USER_INACTIVE | DEFAULT_VPC_IN_USE        │
  │  severity      : str     HIGH | MEDIUM | LOW                           │
  │  title         : str     Short human-readable title                    │
  │  description   : str     What the problem is                           │
  │  recommendation: str     What to do to fix it                         │
  │  metadata      : dict    Extra context (port, username, cidr, etc.)    │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  <<Dict Schema>>  Execution Log Entry  (execution_log.json)             │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  execution_id        : str                                              │
  │  timestamp           : str   ISO 8601 UTC                              │
  │  status              : str   awaiting_approval | applying |            │
  │                              complete | failed | rejected | plan_failed │
  │  description         : str                                              │
  │  issue               : dict  Security finding that triggered the run   │
  │  hcl                 : str   Generated Terraform HCL                  │
  │  plan_output         : str   Raw terraform plan stdout                 │
  │  resources_to_add    : int                                              │
  │  resources_to_change : int                                              │
  │  resources_to_destroy: int                                              │
  │  approved            : bool | None                                      │
  │  apply_output        : str  | None                                      │
  │  resources_applied   : list                                             │
  │  summary             : str   LLM plain-English summary                 │
  │  iterations          : int   Agentic loop count (max 6)                │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

### L4.2 — Security Analyzer

> **File:** `backend/services/security_analyzer.py`

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  L4 · SECURITY ANALYZER — Function Call Graph                                ║
╚══════════════════════════════════════════════════════════════════════════════╝

  caller: REST /security   OR   MCP tool: run_security_analysis_with_summary
                │
                ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  run_security_analysis(scan_data: dict) → list[Finding]              │
  │                                                                      │
  │  Extracts 4 sections from scan_data, fans out to 7 rule functions,  │
  │  collects all findings, sorts HIGH → MEDIUM → LOW                   │
  │                                                                      │
  │  SEVERITY_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}               │
  └──────┬───────────────────────────────────────────────────────────────┘
         │ (called in this order, results extend all_findings)
         │
         ▼
  ┌────────────────────────────────────────────┐
  │  Rule 1: check_ssh_port_open               │ severity: HIGH
  │  input : security_groups_data              │
  │  checks: open_to_internet[].port == 22     │
  │  output: Finding per SG with port 22 open │
  └────────────────────────────────────────────┘

  ┌────────────────────────────────────────────┐
  │  Rule 2: check_rdp_port_open               │ severity: HIGH
  │  input : security_groups_data              │
  │  checks: open_to_internet[].port == 3389   │
  │  output: Finding per SG with port 3389     │
  └────────────────────────────────────────────┘

  ┌────────────────────────────────────────────┐
  │  Rule 3: check_s3_bucket_public            │ severity: HIGH
  │  input : s3_data                           │
  │  checks: bucket["is_public"] == True       │
  │  output: Finding per public bucket         │
  └────────────────────────────────────────────┘

  ┌────────────────────────────────────────────┐
  │  Rule 4: check_iam_user_no_mfa             │ severity: MEDIUM
  │  input : iam_data                          │
  │  checks: user["has_mfa"] == False          │
  │  output: Finding per user without MFA      │
  └────────────────────────────────────────────┘

  ┌────────────────────────────────────────────┐
  │  Rule 5: check_unrestricted_traffic        │ severity: HIGH
  │  input : security_groups_data              │
  │  checks: open_to_internet[].protocol=="-1" │
  │  output: Finding per SG allowing all ports │
  └────────────────────────────────────────────┘

  ┌────────────────────────────────────────────┐
  │  Rule 6: check_iam_user_inactive           │ severity: LOW
  │  input : iam_data                          │
  │  checks: last_login == "Never"             │
  │          OR age > 90 days                  │
  │  output: Finding per inactive IAM user     │
  └────────────────────────────────────────────┘

  ┌────────────────────────────────────────────┐
  │  Rule 7: check_default_vpc                 │ severity: LOW
  │  input : vpc_data                          │
  │  checks: vpc["is_default"] == True         │
  │  output: Finding per default VPC           │
  └────────────────────────────────────────────┘
         │
         │  all rules call
         ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │  make_finding(finding_id, resource_id, resource_type, rule,        │
  │               severity, title, description, recommendation,        │
  │               metadata) → dict                                     │
  │                                                                    │
  │  Factory function. Guarantees every finding has all 9 fields.      │
  │  Called by every rule — no finding is ever created directly.       │
  └────────────────────────────────────────────────────────────────────┘
         │
         ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │  (optional) get_security_summary(findings, model, api_key) → str  │
  │                                                                    │
  │  Builds a structured prompt embedding all findings as JSON.        │
  │  Routes to: chat_with_groq | chat_with_anthropic | chat_with_     │
  │             ollama  based on model param.                          │
  │  Returns plain-English executive summary for the UI.              │
  └────────────────────────────────────────────────────────────────────┘
```

---

### L4.3 — Agent Service (Agentic Loop)

> **File:** `backend/agent_service.py`

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  L4 · AGENT SERVICE — Sequence Diagram                                       ║
╚══════════════════════════════════════════════════════════════════════════════╝

  caller          run_security_agent()     Anthropic API      dispatch_tool()
    │                     │               claude-opus-4-5          │
    │  credentials,       │                      │                  │
    │  issue_index ──────►│                      │                  │
    │                     │                      │                  │
    │              ┌──────▼──────┐               │                  │
    │              │  STEP 1     │               │                  │
    │              │  Scan AWS   │               │                  │
    │              │  (boto3,    │               │                  │
    │              │  5 scanners)│               │                  │
    │              └──────┬──────┘               │                  │
    │                     │ scan_data            │                  │
    │              ┌──────▼──────┐               │                  │
    │              │  STEP 2     │               │                  │
    │              │  Security   │               │                  │
    │              │  Analysis   │               │                  │
    │              │  (7 rules)  │               │                  │
    │              └──────┬──────┘               │                  │
    │                     │ findings[]           │                  │
    │                     │ (sorted HIGH→LOW)    │                  │
    │              ┌──────▼──────┐               │                  │
    │              │  STEP 3     │               │                  │
    │              │  Pick issue │               │                  │
    │              │  by index   │               │                  │
    │              │  (default 0)│               │                  │
    │              └──────┬──────┘               │                  │
    │                     │ target_issue         │                  │
    │              ┌──────▼──────┐               │                  │
    │              │  STEP 4     │               │                  │
    │              │  Build      │               │                  │
    │              │  initial_   │               │                  │
    │              │  message    │               │                  │
    │              └──────┬──────┘               │                  │
    │                     │                      │                  │
    │          ┌──────────▼──── AGENTIC LOOP (max 6 iterations) ────┤
    │          │          │                      │                  │
    │          │   iter++ │  messages[]──────────►                  │
    │          │          │  + SYSTEM_PROMPT     │                  │
    │          │          │  + TOOLS schema      │  response        │
    │          │          │                      ◄──────────────────│
    │          │          │  stop_reason?        │                  │
    │          │          │  ┌─────────────────┐ │                  │
    │          │          │  │  "end_turn"     │ │                  │
    │          │          │  │  └─► break loop │ │                  │
    │          │          │  │                 │ │                  │
    │          │          │  │  "tool_use"     │ │                  │
    │          │          │  │  └─► for each   │ │                  │
    │          │          │  │  tool_use block:│ │                  │
    │          │          │  │                 │ │                  │
    │          │          │  │  dispatch_tool( │────────────────────►
    │          │          │  │  tool_name,     │ │                  │
    │          │          │  │  tool_input)    │ │     result dict  │
    │          │          │  │                 │◄────────────────────
    │          │          │  │                 │ │                  │
    │          │          │  │  collect:       │ │                  │
    │          │          │  │  "generate_     │ │                  │
    │          │          │  │   terraform"    │ │                  │
    │          │          │  │  → collected_hcl│ │                  │
    │          │          │  │                 │ │                  │
    │          │          │  │  "run_terraform │ │                  │
    │          │          │  │   _plan"        │ │                  │
    │          │          │  │  → collected_   │ │                  │
    │          │          │  │    plan_output  │ │                  │
    │          │          │  │                 │ │                  │
    │          │          │  │  "summarise_    │ │                  │
    │          │          │  │   plan_for_     │ │                  │
    │          │          │  │   human"        │ │                  │
    │          │          │  │  → collected_   │ │                  │
    │          │          │  │    summary      │ │                  │
    │          │          │  │                 │ │                  │
    │          │          │  │  feed results   │ │                  │
    │          │          │  │  back to model  │ │                  │
    │          └──────────┘  └─────────────────┘ │                  │
    │                     │                      │                  │
    │              ┌──────▼──────┐               │                  │
    │              │  STEP 5     │               │                  │
    │              │  run_terra  │               │                  │
    │              │  form_plan  │               │                  │
    │              │  (persistent│               │                  │
    │              │   plan file)│               │                  │
    │              └──────┬──────┘               │                  │
    │              ┌──────▼──────┐               │                  │
    │              │  STEP 6     │               │                  │
    │              │  log_       │               │                  │
    │              │  execution  │               │                  │
    │              │  (JSON file)│               │                  │
    │              └──────┬──────┘               │                  │
    │                     │                      │                  │
    │    {status,         │                      │                  │
    │     execution_id,   │                      │                  │
    │     issue, hcl,     │                      │                  │
    │     plan_output,    │                      │                  │
    │     summary}        │                      │                  │
    │◄────────────────────┘                      │                  │


  dispatch_tool() — routes tool_name to handler
  ─────────────────────────────────────────────
  "generate_terraform"       → handle_generate_terraform(hcl, resource_type, description)
  "run_terraform_plan"       → handle_run_terraform_plan(hcl_content, description)
  "summarise_plan_for_human" → handle_summarise_plan(plan_output, issue, risk_level)


  approve_and_apply(execution_id, credentials) — called only on human approval
  ──────────────────────────────────────────────────────────────────────────────
  log_execution_update(id, {status: "applying", approved: True})
       │
       ▼
  run_terraform_apply(execution_id)   ← uses saved tfplan binary
       │
       ▼
  log_execution_update(id, {status: "complete"|"failed", apply_output})
       │
       ▼
  return {status, output}
```

---

### L4.4 — LLM Service

> **File:** `backend/services/llm_service.py`

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  L4 · LLM SERVICE — Provider Routing                                         ║
╚══════════════════════════════════════════════════════════════════════════════╝

  callers: /chat endpoint, /security, /cost, /rag/query, agent_service
                             │
            ┌────────────────┼───────────────┐
            │model="groq"    │model="anthropic│  model="ollama"
            ▼                ▼                ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────────┐
  │chat_with_    │  │chat_with_    │  │chat_with_ollama                  │
  │groq()        │  │anthropic()   │  │                                  │
  │              │  │              │  │ Compresses scan_data to compact  │
  │ Full scan    │  │ Full scan    │  │ summary before sending (smaller  │
  │ data in sys  │  │ data in top- │  │ context for local model)         │
  │ prompt (msgs │  │ level system │  │                                  │
  │ array)       │  │ field — NOT  │  │ No API key required              │
  │              │  │ in messages  │  │ Times out at 180s (model load)   │
  │ model:       │  │ array        │  │                                  │
  │ llama-3.3-   │  │              │  │ model: minimax-m2.7:cloud        │
  │ 70b-versatile│  │ model:       │  │ endpoint: localhost:11434/       │
  │              │  │ claude-haiku │  │           api/chat               │
  │ temp: 0.3    │  │ -4-5-20251001│  │                                  │
  │ max_tok: 1024│  │ max_tok: 1024│  │                                  │
  │              │  │              │  │                                  │
  │ httpx 30s    │  │ httpx 30s    │  │ httpx 180s timeout               │
  └──────┬───────┘  └──────┬───────┘  └────────────────┬─────────────────┘
         │                 │                           │
         │ POST            │ POST                      │ POST
         │ api.groq.com    │ api.anthropic.com         │ localhost:11434
         │ /openai/v1/     │ /v1/messages              │ /api/chat
         │ chat/completions│                           │
         ▼                 ▼                           ▼
       str reply        str reply                   str reply


  Key difference — system prompt placement:

  Groq / Ollama format:           Anthropic format:
  ─────────────────────           ─────────────────
  messages: [                     system: "<scan data>"  ← top-level field
    {role:"system",content:...},  messages: [
    ...history,                     ...history,
    {role:"user",content:msg}       {role:"user",content:msg}
  ]                               ]

  API key resolution (same pattern in all 3 providers):
  ┌─────────────────────────────────────────────────┐
  │  if api_key param provided and non-empty:        │
  │      use api_key param  (user runtime key)      │
  │  else:                                          │
  │      use os.getenv("GROQ/ANTHROPIC_API_KEY")    │
  │      (server .env file)                         │
  └─────────────────────────────────────────────────┘
```

---

### L4.5 — Terraform Service

> **File:** `backend/services/terraform_service.py`

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  L4 · TERRAFORM SERVICE — Generation + Execution Pipeline                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

  GENERATION PIPELINE
  ────────────────────

  generate_terraform(request: str, model: str, api_key: str) → dict
       │
       ├── model == "anthropic" ──────────────────────────────────────────┐
       │                                                                   │
       │   generate_terraform_with_anthropic(request, api_key)            │
       │   ┌──────────────────────────────────────────────────┐           │
       │   │  Uses tool_choice = {"type":"tool",              │           │
       │   │                      "name":"generate_terraform"} │           │
       │   │  Forces model to return structured tool_use block │           │
       │   │  (guaranteed JSON — no parsing heuristics)        │           │
       │   │                                                   │           │
       │   │  model: claude-haiku-20240307                     │           │
       │   │  Returns: {hcl, resource_type, description}       │           │
       │   └──────────────────────────────────────────────────┘           │
       │                                                                   │
       └── model == "groq" (default) ──────────────────────────────────┐  │
                                                                        │  │
           generate_terraform_with_groq(request, api_key)              │  │
           ┌──────────────────────────────────────────────────┐        │  │
           │  Groq has no tool_choice → uses prompt template  │        │  │
           │  Asks for two fenced code blocks:                │        │  │
           │    ```hcl ... ```    (the Terraform code)        │        │  │
           │    ```json ... ```   (resource_type, description) │        │  │
           │  Parses with regex: re.search(r"```hcl...```")   │        │  │
           │                     re.search(r"```json...```")  │        │  │
           │  model: llama-3.3-70b-versatile, temp=0.1        │        │  │
           └──────────────────────────────────────────────────┘        │  │
                        │                              │               │  │
                        └──────────────────────────────┘               │  │
                                       │                               │  │
                                       └───────────────────────────────┘  │
                                                       │
                                                       ▼
                              validate_terraform_syntax(hcl) → dict
                              ┌───────────────────────────────────┐
                              │  1. Write hcl to tempfile         │
                              │  2. subprocess: terraform init    │
                              │                -backend=false     │
                              │                timeout=120s       │
                              │  3. subprocess: terraform validate│
                              │                timeout=30s        │
                              │  Returns: {valid: bool,           │
                              │            message: str}          │
                              │  tempdir auto-deleted after       │
                              └───────────────────────────────────┘
                                                       │
                                                       ▼
                              return {hcl, resource_type, description,
                                      validation: {valid, message},
                                      error: None}


  EXECUTION PIPELINE
  ────────────────────

  run_terraform_plan(hcl, execution_id)
  ┌──────────────────────────────────────────────────────────────┐
  │  tempfile.mkdtemp(prefix="aca_plan_")  ← PERSISTENT dir     │
  │  Write hcl → main.tf                                         │
  │  subprocess: terraform init -backend=false  timeout=120s     │
  │  subprocess: terraform plan -no-color       timeout=180s     │
  │  Returns: {success, plan_output, return_code, working_dir}   │
  │                                                              │
  │  NOTE: mkdtemp (not TemporaryDirectory) — dir survives so    │
  │  run_terraform_apply can use the saved tfplan binary later   │
  └──────────────────────────────────────────────────────────────┘

  run_terraform_apply(execution_id)
  ┌──────────────────────────────────────────────────────────────┐
  │  Look up working_dir from execution log by execution_id      │
  │  subprocess: terraform apply -auto-approve -no-color         │
  │              timeout=300s                                    │
  │  Returns: {success, apply_output, resources_applied}         │
  └──────────────────────────────────────────────────────────────┘

  handle_summarise_plan(plan_output, issue, risk_level) → dict
  ┌──────────────────────────────────────────────────────────────┐
  │  Parse plan_output with regex:                               │
  │  "Plan: X to add, Y to change, Z to destroy."               │
  │                                                              │
  │  safe_to_approve logic:                                      │
  │    destroys > 0  → risk = "high", safe = False              │
  │    risk == "high" → safe = False                            │
  │    otherwise      → safe = True                             │
  │                                                              │
  │  Returns: {summary, changes_count, risk_level,              │
  │            safe_to_approve}                                  │
  └──────────────────────────────────────────────────────────────┘
```

---

## C4 Level Summary

| Level | Audience | Question answered | Diagram type |
|---|---|---|---|
| **L1** Context | Executives, stakeholders | What does the system do and who uses it? | System context |
| **L2** Container | Architects, DevOps | What deploys and how do pieces connect? | Container map |
| **L3** Component | Developers | What are the internal building blocks? | Component map |
| **L4** Code | Individual devs | How is a specific component implemented? | Call graphs, sequence diagrams, data models |

> Each level is a zoom-in on the previous. You never put everything in one diagram.  
> This is the **C4 Model** — the current industry standard for architecture documentation,  
> used by companies including AWS, Spotify, Netflix, and Google.
