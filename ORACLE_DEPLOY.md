# Oracle Cloud Always Free — Deployment Guide
### Agentic Cloud Assistant (ACA)
**Cost: $0 forever | Region: UK South (London) | Estimated setup time: 45–60 min**

---

## Prerequisites Checklist

Before starting, confirm you have:

- [x] Oracle Cloud account created (card verified — done)
- [x] Budget alert set to $1 (done)
- [ ] SSH key downloaded from Oracle during VM creation
- [ ] Groq API key — free at `console.groq.com`
- [ ] Anthropic API key — optional, `console.anthropic.com`
- [ ] Your GitHub repo URL (or local code ready to upload)

---

## Architecture Overview

```
Browser (your laptop / anyone with the IP)
        │  HTTP port 80
        ▼
Oracle VM — Ubuntu 22.04 ARM (4 OCPU, 24GB RAM)
        │
        ├── Docker container: frontend  (Nginx on port 80)
        │       └── serves React SPA
        │       └── proxies /mcp, /rag/, /tools/, /terraform/ → backend
        │
        └── Docker container: backend  (FastAPI + FastMCP on port 8000, internal only)
                └── ChromaDB volume (persistent)
                └── terraform_workdirs volume (persistent)
```

---

## Phase 1 — Create the VM

### Step 1.1 — Navigate to Compute

1. Click the **hamburger menu** (top-left three lines)
2. Go to **Compute → Instances**
3. Click **Create Instance**

---

### Step 1.2 — Configure the Instance

**Name**
```
aca-server
```

**Image** → click **Edit** → click **Change image**
- Select **Canonical Ubuntu**
- Select **Ubuntu 22.04**
- Click **Select image**

**Shape** → click **Change shape**
- Click the **Ampere** tab (ARM processors)
- Select `VM.Standard.A1.Flex`
- Set **OCPUs: 4**
- Set **Memory: 24 GB**
- Confirm badge shows **Always Free-eligible**
- Click **Select shape**

**SSH Keys**
- Select **Generate a key pair for me**
- Click **Save private key** → file named something like `ssh-key-2026-05-10.key` downloads
- **Keep this file. If you lose it you cannot SSH into the VM.**

**Everything else** — leave as default. Do not change networking, boot volume, or any other section.

Click **Create** at the bottom.

---

### Step 1.3 — Wait for Running Status

The instance page will show **Provisioning** (orange) → changes to **Running** (green) in 2–3 minutes.

> If you see **"Out of host capacity"** — wait 30–60 minutes and try again. If it keeps failing after 3 attempts, try creating the instance in a different availability domain (AD-2 or AD-3) — there is a dropdown for this on the create form.

Note your **Public IPv4 address** — you will use it throughout. Example: `158.101.x.x`

---

## Phase 2 — Open Port 80

By default Oracle blocks all inbound traffic except SSH. You need to open port 80.

### Step 2.1

1. Click on your running instance `aca-server`
2. Scroll down to **Primary VNIC** section
3. Click the **Subnet** link

### Step 2.2

1. Click **Security List** (usually named `Default Security List for...`)
2. Click **Add Ingress Rules**
3. Fill in:
   - **Stateless:** unchecked
   - **Source Type:** CIDR
   - **Source CIDR:** `0.0.0.0/0`
   - **IP Protocol:** TCP
   - **Destination Port Range:** `80`
   - **Description:** `HTTP web access`
4. Click **Add Ingress Rules**

Port 80 is now open to the internet.

---

## Phase 3 — Connect via SSH

Open a terminal on your laptop.

### Fix key permissions (Mac/Linux only)
```bash
chmod 400 ~/Downloads/ssh-key-2026-05-10.key
```

### Connect
```bash
ssh -i ~/Downloads/ssh-key-2026-05-10.key ubuntu@YOUR_VM_IP
```

Replace `YOUR_VM_IP` with your actual public IP.

You should see the Ubuntu welcome banner. All commands from here run **inside this SSH session**.

> **Windows users:** Use Windows Terminal or PowerShell — the `ssh` command works the same way. If using PuTTY, convert the `.key` file to `.ppk` using PuTTYgen first.

---

## Phase 4 — Install Docker

Copy and paste this entire block at once:

```bash
sudo apt-get update -y && \
sudo apt-get install -y ca-certificates curl gnupg && \
curl -fsSL https://get.docker.com | sh && \
sudo usermod -aG docker ubuntu && \
sudo apt-get install -y docker-compose-plugin && \
newgrp docker
```

Verify both are installed:
```bash
docker --version
docker compose version
```

Expected output:
```
Docker version 27.x.x ...
Docker Compose version v2.x.x ...
```

---

## Phase 5 — Get the Code onto the Server

### If your GitHub repo is public:
```bash
git clone https://github.com/mihirxtc/ACA-DEV.git
cd ACA-DEV
```

### If your repo is private:
Generate a GitHub Personal Access Token first:
- GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → tick `repo` scope → copy the token

Then clone:
```bash
git clone https://YOUR_TOKEN@github.com/mihirxtc/ACA-DEV.git
cd ACA-DEV
```

### If you want to upload code directly from your laptop (no GitHub):
Run this on your **laptop** (not the server):
```bash
scp -i ~/Downloads/ssh-key-2026-05-10.key -r "/path/to/ACA DEV/ACA-DEV" ubuntu@YOUR_VM_IP:~/ACA-DEV
```
Then on the server: `cd ~/ACA-DEV`

---

## Phase 6 — Set Environment Variables

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

Fill in your values:
```
GROQ_API_KEY=gsk_your_groq_key_here
ANTHROPIC_API_KEY=sk-ant-your_key_here
AWS_DEFAULT_REGION=us-east-1
DEBUG=false
```

> Leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` blank.
> Users supply their own AWS credentials through the web UI — safer than storing them server-side.

Save and exit: `Ctrl+X` → `Y` → `Enter`

---

## Phase 7 — Fix CORS for Production

By default the app only allows requests from `localhost:5173`. On a live server the browser hits your VM's public IP, so you need to allow that.

Open `backend/main.py`:
```bash
nano backend/main.py
```

Find this line (around line 41):
```python
allow_origins=["http://localhost:5173"],
```

Change it to (replace `YOUR_VM_IP` with your actual IP):
```python
allow_origins=["http://localhost:5173", "http://YOUR_VM_IP"],
```

Save: `Ctrl+X` → `Y` → `Enter`

> If you get a domain name later, add it here too: `"http://yourdomain.com"` or use `allow_origins=["*"]` for a dissertation demo where security is less critical.

---

## Phase 8 — Build and Start the Application

```bash
docker compose up -d --build
```

**What this does:**
- Downloads Python 3.11 and Node 20 base images (~500MB, one-time)
- Installs all Python packages (FastAPI, ChromaDB, sentence-transformers, etc.)
- Downloads and installs Terraform binary inside the backend container
- Builds the React frontend into static files
- Starts both containers in the background

**First build takes 10–20 minutes.** Watch it live:
```bash
docker compose logs -f
```

Wait until you see:
```
backend-1  | INFO:     Application startup complete.
```

Press `Ctrl+C` to stop watching logs. Containers keep running in the background.

---

## Phase 9 — Verify Everything Works

```bash
# Check both containers are running
docker compose ps
```

Expected:
```
NAME         STATUS
backend-1    running (healthy)
frontend-1   running
```

```bash
# Health check
curl http://localhost/health
```

Expected: `{"status":"ok","version":"2.0.0"}`

---

## Phase 10 — Access Your Live App

Open a browser and go to:
```
http://YOUR_VM_IP
```

You should see the Agentic Cloud Assistant dashboard.

**To use it:**
1. Go to **Settings / Credentials** tab in the UI
2. Enter your **AWS Access Key ID**, **Secret Access Key**, and **Region**
3. Select LLM model — **Groq** for free, **Anthropic** for best quality
4. Click **Scan** to begin scanning your AWS infrastructure

---

## Oracle Cloud Specific: Idle Reclamation Warning

Oracle reclaims Always Free VMs that are idle for 7 consecutive days:
- CPU < 20%
- Network < 20%
- Memory < 20%

**While you're actively using the app this will never trigger.** After dissertation submission, if you want to keep the VM alive without using it, run this cron job on the server:

```bash
# Keeps CPU just above idle threshold — run once after deployment
(crontab -l 2>/dev/null; echo "*/5 * * * * dd if=/dev/urandom of=/dev/null bs=1M count=1 2>/dev/null") | crontab -
```

---

## Day-to-Day Commands

```bash
# Check status
docker compose ps

# Watch live logs
docker compose logs -f

# Watch only backend logs
docker compose logs -f backend

# Restart after .env changes
docker compose restart

# Stop everything (data kept)
docker compose down

# Pull latest code and redeploy
git pull && docker compose up -d --build

# Check disk usage
docker system df
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| SSH: Permission denied | Run `chmod 400 your-key.key` on your laptop first |
| SSH: Connection timed out | Port 22 not open — check Security List has SSH ingress rule |
| Browser: Connection refused | Port 80 not open — re-check Phase 2 ingress rule |
| `docker compose` not found | Try `docker-compose` with a hyphen instead |
| Backend keeps restarting | Run `docker compose logs backend` — usually a missing .env value |
| Out of host capacity | Wait 30–60 min, retry. Try a different Availability Domain |
| AWS scan: Access Denied | Check IAM permissions. Minimum: `ec2:Describe*`, `s3:List*`, `iam:List*`, `ce:Get*` |

---

## Cost Summary — Honest

| Item | Cost |
|---|---|
| VM.Standard.A1.Flex (4 OCPU, 24GB) | $0 — Always Free |
| 200GB Block Storage | $0 — Always Free |
| 10TB/month Bandwidth | $0 — Always Free |
| Public IP | $0 — Always Free |
| Card verification hold | $1 (returned in 3–5 days) |
| **Total for dissertation** | **$0** |

> Always Free resources have no 12-month limit. The VM runs forever at $0 as long as your account stays active and you don't provision paid resources.

---

## IAM Permissions Needed for AWS Scanning

The AWS credentials entered in the dashboard need these minimum permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "s3:ListAllMyBuckets",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketAcl",
        "iam:ListUsers",
        "iam:ListMFADevices",
        "iam:GetLoginProfile",
        "ce:GetCostAndUsage",
        "ce:GetCostForecast",
        "sts:GetCallerIdentity",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupIngress"
      ],
      "Resource": "*"
    }
  ]
}
```

---

*ACA Oracle Cloud Deployment Guide | Mihir | May 2026*
