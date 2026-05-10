# ACA-MCP — Full DevOps Lifecycle

Complete guide to containerisation, security scanning, CI/CD, automated deployment, and monitoring.  
**Total setup time: ~2 hours** | **Ongoing cost: $0 extra** (all free tiers)

---

## What You Are Building

Every code push triggers this automated pipeline:

```
You push code to GitHub
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Actions — CI (runs on every push + pull request) │
│                                                          │
│  1. ESLint  — checks React code style                    │
│  2. Bandit  — scans Python for security vulnerabilities  │
│  3. Pytest  — runs automated backend tests               │
│  4. Trivy   — scans Docker files for known CVEs          │
└──────────────────────────┬──────────────────────────────┘
                           │ all checks pass?
                           ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Actions — CD (runs only on push to main branch)  │
│                                                          │
│  SSH into EC2 → git pull → docker compose up --build     │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
         ┌─────────────────────────────────────┐
         │     EC2 Ubuntu t3.medium             │
         │                                      │
         │  frontend   → port 80   (React/Nginx) │
         │  backend    → port 8000 (FastAPI/MCP) │
         │  prometheus → port 9090 (metrics)     │
         │  grafana    → port 3000 (dashboards)  │
         │  node-exp   → port 9100 (system data) │
         └─────────────────────────────────────┘
                           │
                           ▼
              UptimeRobot pings every 5 min
              → emails you if site goes down
```

**Tech stack chosen and why:**

| Tool | What it does | Why this one |
|---|---|---|
| GitHub Actions | Runs CI/CD pipelines automatically | Free (2000 min/month), built into GitHub, industry standard |
| Bandit | Scans Python code for security bugs | Free, zero config, widely used |
| Trivy | Scans Docker images for CVEs | Free, fastest scanner, used by major companies |
| Prometheus | Collects metrics (CPU, requests, errors) | Open-source, industry standard |
| Grafana | Dashboards and alerting UI | Open-source, pairs with Prometheus, looks great on CV |
| UptimeRobot | Pings your site every 5 min | Free, zero install, emails you when site is down |

---

## Phase 1: Containerisation — Already Done

Your project already has Docker and Docker Compose set up. Quick checklist:

- [x] `backend/Dockerfile` — builds the Python + Terraform image
- [x] `frontend/Dockerfile` — builds the React app and wraps it in Nginx
- [x] `docker-compose.yml` — starts both containers together
- [x] `backend/.dockerignore` — stops secrets (.env, __pycache__) from entering the image
- [x] `frontend/.dockerignore` — stops node_modules from entering the image

Nothing to do here. Move to Phase 2.

---

## Phase 2: GitHub Repository Setup

### 2a — Push Your Code to GitHub (if not already done)

On your local machine:

```bash
cd ~/workspace/p2898186/ACA-MCP

# Initialise git (skip if already a git repo)
git init
git branch -M main

# Create the repo on GitHub first, then:
git remote add origin https://github.com/YOUR_USERNAME/ACA-MCP.git

# Make sure .gitignore covers secrets
echo "backend/.env" >> .gitignore
echo "backend/chroma_db/" >> .gitignore
echo "backend/terraform_workdirs/" >> .gitignore
echo "backend/venv/" >> .gitignore

git add .
git commit -m "feat: initial commit with full DevOps setup"
git push -u origin main
```

### 2b — Enable Dependabot (automatic dependency security updates)

In your GitHub repo → **Settings** → **Security** → **Code security and analysis** → enable:
- **Dependency graph** → On
- **Dependabot alerts** → On
- **Dependabot security updates** → On

Dependabot will open pull requests automatically when any of your Python or npm packages have known security vulnerabilities. You just review and merge.

### 2c — Create the GitHub Secrets (for CD to SSH into EC2)

The CD pipeline needs to SSH into your EC2 instance. You do this by giving GitHub a private SSH key — stored as a secret, never visible in logs.

**Step 1 — Generate a dedicated deploy SSH key (run this on your laptop):**

```bash
# Generate a new key pair specifically for GitHub Actions
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/aca_deploy_key -N ""

# This creates two files:
# ~/.ssh/aca_deploy_key      ← private key (goes into GitHub Secrets)
# ~/.ssh/aca_deploy_key.pub  ← public key (goes onto the EC2 server)
```

**Step 2 — Add the public key to your EC2 instance:**

```bash
# Copy the public key content
cat ~/.ssh/aca_deploy_key.pub

# SSH into your EC2 instance
ssh -i ~/Downloads/aca-key.pem ubuntu@YOUR_EC2_IP

# On the EC2 server, add the deploy key to authorized_keys
echo "PASTE_PUBLIC_KEY_CONTENT_HERE" >> ~/.ssh/authorized_keys

# Exit the server
exit
```

**Step 3 — Test that the deploy key works:**

```bash
ssh -i ~/.ssh/aca_deploy_key ubuntu@YOUR_EC2_IP
# Should connect without asking for the .pem file
exit
```

**Step 4 — Add secrets to GitHub:**

Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these three secrets:

| Secret name | Value |
|---|---|
| `EC2_HOST` | Your EC2 public IP (e.g., `3.15.120.45`) |
| `EC2_SSH_KEY` | Contents of `~/.ssh/aca_deploy_key` (the private key — the whole file including `-----BEGIN...-----END` lines) |
| `EC2_USER` | `ubuntu` |

### 2d — Enable Branch Protection on `main`

GitHub repo → **Settings** → **Branches** → **Add branch protection rule**

- Branch name pattern: `main`
- Check: **Require status checks to pass before merging**
- Check: **Require branches to be up to date before merging**
- Click **Save changes**

Now no code can reach `main` without passing CI first.

---

## Phase 3: CI Pipeline

Create this file. Every directory and file name must match exactly.

**Create the directory:**
```bash
mkdir -p .github/workflows
```

**Create `.github/workflows/ci.yml`** with this exact content:

```yaml
name: CI

# Run on every push and every pull request targeting main
on:
  push:
  pull_request:
    branches: [main]

jobs:

  # ── Job 1: Python security scan + tests ─────────────────────────────────────
  backend:
    name: Backend — Lint, Security, Tests
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Python 3.11
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: pip

      - name: Install dependencies
        run: pip install -r backend/requirements.txt bandit pytest pytest-timeout

      - name: Bandit — Python security scan
        # -ll = only report medium and high severity issues
        # Skips the tests/ and venv/ directories (test code has different rules)
        run: bandit -r backend/ -ll --exclude backend/tests,backend/venv -q

      - name: Cache HuggingFace sentence-transformer model
        uses: actions/cache@v4
        with:
          path: ~/.cache/huggingface
          key: huggingface-all-MiniLM-L6-v2-v1

      - name: Pytest — functional tests (no live server needed)
        # test_rag_integration.py requires a running server — skip it in CI
        run: |
          cd backend
          python -m pytest tests/test_rag_functional.py -v --timeout=120
        env:
          PYTHONPATH: .
          TRANSFORMERS_CACHE: ~/.cache/huggingface
          GROQ_API_KEY: ci-placeholder
          ANTHROPIC_API_KEY: ci-placeholder
          AWS_DEFAULT_REGION: us-east-1

  # ── Job 2: Frontend lint ──────────────────────────────────────────────────────
  frontend:
    name: Frontend — ESLint
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - name: Install npm dependencies
        run: npm ci
        working-directory: frontend

      - name: Run ESLint
        run: npm run lint
        working-directory: frontend

  # ── Job 3: Docker image security scan ────────────────────────────────────────
  trivy:
    name: Trivy — Container Security Scan
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Build backend image for scanning
        run: docker build -t aca-backend:scan ./backend

      - name: Trivy — scan backend image for CVEs
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: aca-backend:scan
          format: table
          severity: CRITICAL,HIGH
          # exit-code 0 means: report findings but don't fail the pipeline
          # Change to '1' once you've resolved existing CVEs
          exit-code: '0'
```

**What each job does:**

- **backend** — installs your Python dependencies, runs Bandit to catch security mistakes in your code (e.g., hardcoded secrets, SQL injection patterns, unsafe `exec()` calls), then runs your pytest functional tests
- **frontend** — runs ESLint to catch React bugs and code style issues
- **trivy** — builds your Docker image and checks every installed package against a database of 200,000+ known vulnerabilities (CVEs)

---

## Phase 4: CD Pipeline — Automated Deployment

Create `.github/workflows/cd.yml`:

```yaml
name: CD

# Only run when code lands on the main branch
# (PRs run CI only — this only fires after a merge)
on:
  push:
    branches: [main]

jobs:
  deploy:
    name: Deploy to EC2
    runs-on: ubuntu-latest

    steps:
      - name: SSH into EC2 and deploy
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          # Commands run on the EC2 server inside this block
          script: |
            set -e  # Stop immediately if any command fails

            echo "==> Pulling latest code"
            cd ~/ACA-MCP
            git pull origin main

            echo "==> Rebuilding and restarting containers"
            docker compose up -d --build

            echo "==> Cleaning up old Docker layers"
            docker system prune -f

            echo "==> Health check"
            sleep 10
            curl -f http://localhost/health && echo "Deploy successful"
```

**How this works:**

1. Someone merges a PR into `main`
2. GitHub Actions starts a small Ubuntu virtual machine
3. It SSHs into your EC2 using the private key stored in GitHub Secrets
4. On the server: pulls the new code, rebuilds the Docker images, restarts containers
5. Runs a health check — if it fails, you see a red X in GitHub
6. Total time: ~5–8 minutes from merge to live

**Test it:** Push any change to `main` and watch the **Actions** tab in your GitHub repo. You'll see each step run in real time.

---

## Phase 5: Add Application Metrics to Backend

Before setting up Prometheus, add 2 lines to the backend so it exposes a `/metrics` endpoint. This gives you request counts, latency, error rates — the most valuable data for monitoring a web API.

**5a — Add the library to `backend/requirements.txt`:**

At the end of the file, add:
```
prometheus-fastapi-instrumentator
```

**5b — Add 2 lines to `backend/main.py`** right after the `app.add_middleware(...)` block:

```python
# Expose Prometheus metrics at /metrics
from prometheus_fastapi_instrumentator import Instrumentator
Instrumentator().instrument(app).expose(app)
```

The full relevant section of `main.py` should look like this after the edit:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
    expose_headers=["mcp-session-id"],
)

# Expose Prometheus metrics at /metrics
from prometheus_fastapi_instrumentator import Instrumentator
Instrumentator().instrument(app).expose(app)

# Mount MCP server — handles all /mcp requests
app.mount("/mcp", _mcp_http_app)
```

After this, your backend will serve live metrics at `http://YOUR_EC2_IP:8000/metrics`. Prometheus will scrape this every 15 seconds.

---

## Phase 6: Monitoring with Prometheus + Grafana

### 6a — Create the Prometheus config file

Create a new directory and config file:

```bash
mkdir -p monitoring
```

Create `monitoring/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s       # Collect metrics every 15 seconds
  evaluation_interval: 15s   # Evaluate alert rules every 15 seconds

scrape_configs:

  # Your FastAPI backend — request counts, latency, error rates
  - job_name: 'aca-backend'
    static_configs:
      - targets: ['backend:8000']
    metrics_path: /metrics

  # EC2 system metrics — CPU, RAM, disk, network
  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  # Prometheus monitoring itself
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
```

### 6b — Add monitoring services to docker-compose.yml

Open `docker-compose.yml` and add the three new services, then update the `volumes:` section at the bottom.

The full updated file should look like this:

```yaml
services:
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    env_file:
      - ./backend/.env
    volumes:
      - chroma_data:/app/chroma_db
      - terraform_workdirs:/app/terraform_workdirs
    expose:
      - "8000"
    restart: unless-stopped
    healthcheck:
      test: [ "CMD", "curl", "-f", "http://localhost:8000/health" ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        VITE_MCP_URL: /mcp
    ports:
      - "80:80"
    depends_on:
      backend:
        condition: service_healthy
    restart: unless-stopped

  # ── Monitoring stack ─────────────────────────────────────────────────────────

  node-exporter:
    image: prom/node-exporter:latest
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.rootfs=/rootfs'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    expose:
      - "9100"
    restart: unless-stopped

  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=7d'
    expose:
      - "9090"
    restart: unless-stopped
    depends_on:
      - backend
      - node-exporter

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    volumes:
      - grafana_data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=changeme123
      - GF_USERS_ALLOW_SIGN_UP=false
    restart: unless-stopped
    depends_on:
      - prometheus

volumes:
  chroma_data:
  terraform_workdirs:
  prometheus_data:
  grafana_data:
```

> **Change `GF_SECURITY_ADMIN_PASSWORD`** to something strong before deploying.

### 6c — Open port 3000 on EC2

The Grafana dashboard runs on port 3000. Add it to your EC2 Security Group:

AWS Console → EC2 → Security Groups → your instance's group → **Inbound rules** → **Edit** → **Add rule**:

| Type | Port | Source |
|---|---|---|
| Custom TCP | 3000 | My IP (only you can see dashboards) |

Use **My IP** not **Anywhere** — you don't want Grafana publicly accessible.

### 6d — Deploy and open Grafana

Push the changes to `main` (CI/CD will auto-deploy), or deploy manually on the server:

```bash
cd ~/ACA-MCP
git pull
docker compose up -d --build
```

Then open Grafana in your browser:

```
http://YOUR_EC2_IP:3000
```

Login: `admin` / `changeme123`

**Set up Prometheus as a data source:**

1. Grafana sidebar → **Connections** → **Data sources** → **Add new data source**
2. Select **Prometheus**
3. URL: `http://prometheus:9090`
4. Click **Save & test** — you should see "Successfully queried the Prometheus API"

**Import a pre-built dashboard for Node Exporter (EC2 system metrics):**

1. Grafana sidebar → **Dashboards** → **Import**
2. Enter dashboard ID: `1860` (Node Exporter Full — most popular open-source dashboard)
3. Select your Prometheus data source
4. Click **Import**

You now have a dashboard showing CPU usage, memory, disk I/O, and network traffic for your EC2 instance.

**Import a pre-built dashboard for FastAPI metrics:**

1. Dashboards → Import → ID: `16110` (FastAPI Observability)
2. Select Prometheus data source → Import

This shows requests per second, error rate, and response time percentiles for your backend.

---

## Phase 7: Uptime Monitoring with UptimeRobot

This takes 5 minutes and emails you the moment your site goes down.

1. Go to https://uptimerobot.com → **Sign Up** (free)

2. **Add New Monitor**:
   - Monitor Type: **HTTP(s)**
   - Friendly Name: `ACA-MCP Dashboard`
   - URL: `http://YOUR_EC2_IP/health`
   - Monitoring Interval: **5 minutes**

3. Under **Alert Contacts**, add your email address

4. Click **Create Monitor**

UptimeRobot will now ping your `/health` endpoint every 5 minutes. If it doesn't respond, you get an email immediately. The free plan supports 50 monitors.

---

## Final File Structure

After completing all phases, your repo should have these new files:

```
ACA-MCP/
├── .github/
│   └── workflows/
│       ├── ci.yml          ← lint + security + tests (every push)
│       └── cd.yml          ← auto-deploy to EC2 (push to main only)
├── monitoring/
│   └── prometheus.yml      ← Prometheus scrape config
├── backend/
│   ├── main.py             ← (modified) added 2 lines for /metrics
│   └── requirements.txt    ← (modified) added prometheus-fastapi-instrumentator
├── docker-compose.yml      ← (modified) added node-exporter, prometheus, grafana
└── devops_lifecycle.md     ← this file
```

---

## Verifying the Full Pipeline Works

**Trigger CI manually** — push any small change:
```bash
echo "# test" >> README.md
git add README.md && git commit -m "ci: trigger pipeline test"
git push origin main
```

Watch: GitHub repo → **Actions** tab → you should see the CI workflow start within seconds, then the CD workflow after CI passes.

**Check all containers are healthy on the server:**
```bash
docker compose ps
# All 5 containers should show "running" or "running (healthy)"
```

**Check Prometheus is receiving metrics:**

Open `http://YOUR_EC2_IP:9090` (temporarily add port 9090 to EC2 security group for testing):
- Go to **Status** → **Targets** — all three jobs (aca-backend, node-exporter, prometheus) should show `UP`

**Check Grafana dashboards have data:**
- Open `http://YOUR_EC2_IP:3000`
- Open the Node Exporter Full dashboard — graphs should show real data within 30 seconds

---

## Troubleshooting

**GitHub Actions CI fails on Bandit:**
- Read the output — it will point to a specific file and line number
- Common fixes: removing a hardcoded string that looks like a password, replacing `subprocess.run(shell=True)` with a list of arguments
- You can suppress a false positive with `# nosec` at the end of the line

**GitHub Actions CD fails with "SSH connection refused":**
- Confirm `EC2_HOST` secret is just the IP (no `ubuntu@`, no `http://`)
- Confirm `EC2_SSH_KEY` contains the full private key including the `-----BEGIN...` and `-----END...` lines
- Test the key locally: `ssh -i ~/.ssh/aca_deploy_key ubuntu@YOUR_EC2_IP`
- Check port 22 is open in EC2 Security Group

**GitHub Actions CD fails at `git pull`:**
- The repo must exist at `~/ACA-MCP` on the server
- If it's in a different location, update the `cd` command in `cd.yml`

**Grafana shows "No data":**
- Check that Prometheus data source URL is exactly `http://prometheus:9090` (Docker internal network)
- Run `docker compose logs prometheus` to see if there are scrape errors
- Check Prometheus Targets page — jobs must be `UP` not `DOWN`

**Trivy reports many CVEs:**
- `exit-code: '0'` means CI won't fail — it just reports. Keep it at `0` for now.
- The findings are in your base image (`python:3.11-slim`). Most are low risk for a demo.
- To fix: pin to a specific digest or switch to `python:3.11-slim-bookworm`

**Pytest fails in CI on model download:**
- The HuggingFace cache action handles this — first run will be slow (~3 min), subsequent runs use cache
- If it still times out: increase `--timeout=120` to `--timeout=300`

---

## Cost Summary

| Addition | Cost |
|---|---|
| GitHub Actions (2000 min/month free) | $0 |
| Dependabot security alerts | $0 |
| Prometheus + Grafana (runs on same EC2) | $0 — uses existing server RAM |
| UptimeRobot (50 monitors free) | $0 |
| Extra RAM from monitoring stack | ~600 MB — stays within t3.medium's 4 GB |
| **Total extra cost** | **$0** |

---

## What to Put on Your CV

Under a **DevOps / Infrastructure** section:

> **Agentic Cloud Assistant — Full DevOps Pipeline**  
> Implemented end-to-end DevOps lifecycle on an AI-powered AWS management tool:
> - Containerised multi-service application with Docker and Docker Compose (Python/FastAPI backend, React/Nginx frontend)
> - Built GitHub Actions CI/CD pipeline: automated linting (ESLint, Bandit SAST), testing (pytest), container vulnerability scanning (Trivy), and zero-downtime deployment via SSH to EC2
> - Configured Prometheus + Grafana observability stack with application-level metrics (request rate, latency, error rate via prometheus-fastapi-instrumentator) and host metrics (CPU, memory, disk via Node Exporter)
> - Set up automated dependency security patching via GitHub Dependabot
> - Implemented branch protection rules enforcing CI gate before any merge to main

**Keywords that come up in DevOps job descriptions this covers:**
Docker, Docker Compose, GitHub Actions, CI/CD, SAST, container scanning, Trivy, Bandit, Prometheus, Grafana, observability, metrics, alerting, Nginx, Linux, EC2, SSH, Infrastructure as Code, branch protection, Dependabot

---

## Interview Answers (Common DevOps Questions)

**"Walk me through your CI/CD pipeline."**
> "On every push, GitHub Actions runs three parallel jobs: Bandit scans the Python code for security vulnerabilities like hardcoded secrets and unsafe subprocess calls; ESLint checks the React frontend for style and correctness; and Trivy scans the Docker image against a CVE database. Once all three pass, a second workflow SSHs into the EC2 server, pulls the latest code, and rebuilds the containers with zero downtime. The whole pipeline takes about 6 minutes end-to-end."

**"What monitoring do you have in place?"**
> "I have three layers. Application metrics: prometheus-fastapi-instrumentator exposes a /metrics endpoint on the backend, which Prometheus scrapes every 15 seconds — I can see request rate, P99 latency, and error rate in Grafana. System metrics: Node Exporter collects CPU, memory, disk, and network data from the EC2 host, also visualised in Grafana. External uptime: UptimeRobot hits the /health endpoint every 5 minutes and emails me if it goes down."

**"Why did you choose GitHub Actions over Jenkins/CircleCI?"**
> "GitHub Actions is free for public repos and has 2000 free minutes per month for private repos, it's native to GitHub so there's no separate server to maintain, and the marketplace has ready-made actions for everything I needed — Docker builds, SSH deployment, Trivy scanning. For a project this size, running my own Jenkins server would be over-engineering."

**"What is Trivy and why use it?"**
> "Trivy is an open-source vulnerability scanner by Aqua Security. It scans Docker images by checking every installed OS package and language library against the CVE database. I run it in CI so any newly discovered vulnerability in my dependencies fails the pipeline before the code reaches production. The alternative would be finding out about a vulnerability after it's been exploited."

---

*ACA-MCP DevOps Lifecycle Guide | Mihir | May 2026*
