# ACA-MCP — Deployment Instructions

Host the Agentic Cloud Assistant on AWS using Docker Compose.  
**Estimated time:** 30–45 minutes | **Estimated cost:** ~$0.05/hour while running (~$33/month if left on 24/7)

> **Stop the EC2 instance when not in use** — you pay ~$1.60/month for storage alone when stopped.

---

## What You Will Need Before You Start

- An **AWS account** with billing enabled (aws.amazon.com)
- A **Groq API key** — free, no credit card needed → https://console.groq.com
- (Optional) An **Anthropic API key** → https://console.anthropic.com
- Your **GitHub repo URL** for this project (or a zip of the code on your machine)

That is all. Everything else is set up in the steps below.

---

## Overview of What Gets Created

```
Your laptop
    │  SSH
    ▼
EC2 Instance (Ubuntu, t3.medium, port 80 open)
    │
    ├─ Docker container: frontend  (Nginx serves React app on port 80)
    └─ Docker container: backend   (FastAPI + FastMCP on port 8000, internal only)
```

The browser talks to Nginx on port 80. Nginx forwards all `/mcp`, `/rag/`, `/terraform/` requests to the backend container. The backend talks to AWS APIs and LLM providers over the internet.

---

## Step 1 — Launch an EC2 Instance

1. Sign in to **AWS Console** → search for **EC2** → click **Launch Instance**

2. Fill in these settings:

   | Setting | Value |
   |---|---|
   | **Name** | `aca-mcp-server` |
   | **AMI** | Amazon Linux 2023 OR **Ubuntu Server 24.04 LTS** (choose Ubuntu — 64-bit x86) |
   | **Instance type** | `t3.medium` (2 vCPU, 4 GB RAM) — do not go smaller; sentence-transformers needs the RAM |
   | **Key pair** | Click **Create new key pair** → name it `aca-key` → leave type as RSA → click **Create** → the `.pem` file downloads automatically |
   | **Storage** | 20 GB gp3 (the default — leave it) |

3. Under **Network settings**, click **Edit** and add these **Inbound rules**:

   | Type | Port | Source | Why |
   |---|---|---|---|
   | SSH | 22 | **My IP** | So only you can SSH in |
   | HTTP | 80 | **Anywhere** (0.0.0.0/0) | Web dashboard access |

4. Click **Launch Instance**. Wait about 60 seconds.

5. Click the instance ID → note the **Public IPv4 address** (e.g., `3.15.120.45`). You will use this throughout.

---

## Step 2 — SSH Into the Instance

**On Mac or Linux**, open Terminal and run:

```bash
# Move the downloaded key to a safe place and fix permissions
chmod 400 ~/Downloads/aca-key.pem

# Connect (replace 3.15.120.45 with your actual IP)
ssh -i ~/Downloads/aca-key.pem ubuntu@3.15.120.45
```

**On Windows**, use PuTTY or Windows Terminal:
- Convert the `.pem` to `.ppk` using PuTTYgen, then connect with PuTTY
- Or use Windows Terminal: `ssh -i C:\Users\YOU\Downloads\aca-key.pem ubuntu@3.15.120.45`

You will see the Ubuntu welcome banner. All commands from Step 3 onwards run **inside this SSH session** on the server.

---

## Step 3 — Install Docker and Docker Compose

Copy and paste the entire block at once:

```bash
sudo apt-get update -y && \
sudo apt-get install -y docker.io docker-compose-plugin git && \
sudo systemctl start docker && \
sudo systemctl enable docker && \
sudo usermod -aG docker ubuntu && \
newgrp docker
```

Verify the installs worked:

```bash
docker --version
docker compose version
```

Expected: `Docker version 24.x...` and `Docker Compose version v2.x...`

---

## Step 4 — Get the Code onto the Server

**If your repo is public on GitHub:**
```bash
git clone https://github.com/YOUR_USERNAME/ACA-MCP.git
cd ACA-MCP
```

**If your repo is private**, generate a GitHub Personal Access Token first:
- GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → tick `repo` → copy the token

Then clone with the token embedded:
```bash
git clone https://YOUR_TOKEN@github.com/YOUR_USERNAME/ACA-MCP.git
cd ACA-MCP
```

**If you don't have a GitHub repo**, upload the project folder via SCP from your laptop:
```bash
# Run this on your LAPTOP (not the server):
scp -i ~/Downloads/aca-key.pem -r /path/to/ACA-MCP ubuntu@3.15.120.45:~/ACA-MCP
```
Then on the server: `cd ~/ACA-MCP`

---

## Step 5 — Create Your Environment File

The app needs API keys to call LLMs. These go in a `.env` file that never gets committed to Git.

```bash
# Copy the template
cp backend/.env.example backend/.env

# Open the file in the nano text editor
nano backend/.env
```

You will see something like this — fill in your real values:

```
GROQ_API_KEY=your_groq_api_key_here          ← paste your Groq key here
ANTHROPIC_API_KEY=your_anthropic_api_key_here ← paste Anthropic key (or leave blank)
AWS_DEFAULT_REGION=us-east-1
AWS_ACCESS_KEY_ID=                            ← leave blank (users supply keys via UI)
AWS_SECRET_ACCESS_KEY=                        ← leave blank (users supply keys via UI)
DEBUG=false
```

Save and exit nano: press `Ctrl+X`, then `Y`, then `Enter`.

> **Why leave AWS keys blank here?**  
> The web dashboard has a credential input section where each user enters their own AWS Access Key + Secret Key. Those are sent with each tool call rather than stored server-side. This is safer — the server never stores anyone's AWS keys.

---

## Step 6 — Build and Start the Application

```bash
docker compose up -d --build
```

**What this does:**
- Downloads the Python and Node base images (~500 MB, one-time)
- Installs all Python dependencies (FastAPI, ChromaDB, sentence-transformers, etc.)
- Installs Terraform inside the backend container
- Builds the React frontend
- Starts both containers in the background

**This takes 8–15 minutes the first time.** Watch it happen:

```bash
docker compose logs -f
```

Wait until you see:
```
backend-1  | INFO:     Application startup complete.
```

Then press `Ctrl+C` to stop watching logs (containers keep running).

---

## Step 7 — Confirm Everything is Running

```bash
docker compose ps
```

Both rows should show `running (healthy)`:
```
NAME         STATUS
backend-1    running (healthy)
frontend-1   running
```

Do a quick health check:
```bash
curl http://localhost/health
```

Expected: `{"status":"ok"}`

If you see `{"status":"ok"}`, the application is live.

---

## Step 8 — Open the Dashboard

Open a browser on your laptop and go to:

```
http://3.15.120.45
```

(Replace with your actual EC2 public IP.)

You will see the **Agentic Cloud Assistant** dashboard — no login required, it opens directly.

**To use it:**
1. In the **Settings / Credentials** section of the UI, enter your **AWS Access Key ID**, **Secret Access Key**, and **Region**
2. Choose an LLM model (Groq is the default — fastest and free)
3. Optionally enter your Groq or Anthropic API key in the UI (or leave blank to use the server-side key from `.env`)
4. Click **Scan** on the AWS panel to begin scanning your infrastructure

---

## Step 9 — Assign a Static IP (Recommended)

By default, the EC2 public IP **changes every time you stop and restart the instance**. To get a fixed IP that never changes:

1. AWS Console → **EC2** → left sidebar → **Elastic IPs**
2. Click **Allocate Elastic IP address** → **Allocate**
3. Select the new IP → **Actions** → **Associate Elastic IP address**
4. Select your `aca-mcp-server` instance → **Associate**

Your app will now always be at that IP, even after reboots.

---

## Step 10 — (Optional) Add HTTPS with a Free Certificate

Only needed if you have a domain name (e.g., `aca.yourdomain.com`).

**10a — Point your domain to the Elastic IP:**
In your domain registrar (Namecheap, GoDaddy, etc.) or AWS Route 53, create an **A record**:
- Host: `aca` (or `@` for root domain)
- Value: your Elastic IP

Wait 5–30 minutes for DNS to propagate.

**10b — Get a free TLS certificate via Certbot:**
```bash
# Stop the frontend container briefly so port 80 is free for Certbot
docker compose stop frontend

# Install Certbot and get certificate
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d aca.yourdomain.com

# Certificate files will be at:
# /etc/letsencrypt/live/aca.yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/aca.yourdomain.com/privkey.pem

# Restart the frontend
docker compose start frontend
```

**10c — Update Nginx to serve HTTPS:**
Edit `frontend/nginx.conf` to add port 443 with SSL, mount the certificate files into the frontend container via `docker-compose.yml`, then rebuild. This is an advanced configuration step — for a university demo, plain HTTP on the public IP is entirely sufficient.

---

## Day-to-Day Commands

```bash
# Check what's running
docker compose ps

# See live logs (all containers)
docker compose logs -f

# See only backend logs
docker compose logs -f backend

# Restart after changing .env
docker compose restart

# Stop the app (containers removed, volumes kept)
docker compose down

# ⚠ Stop and DELETE all data (ChromaDB + Terraform history wiped)
docker compose down -v

# Pull code updates and redeploy
git pull
docker compose up -d --build

# Check disk usage
docker system df
```

---

## Stopping the Instance to Save Money

**Stop (not terminate) the instance when not using it:**

AWS Console → EC2 → Instances → select `aca-mcp-server` → **Instance State** → **Stop**

- Stopped instances cost ~$0.002/hour (just the 20 GB EBS disk)
- Start it again the same way: **Instance State** → **Start**
- If you used an Elastic IP, your public IP stays the same after restart
- If no Elastic IP, the public IP changes — get a new one from the console

---

## Cost Estimate

| Resource | Details | Est. Cost/Month |
|---|---|---|
| EC2 t3.medium | On-demand, running 24/7 | ~$30.37 |
| EBS 20 GB gp3 | Charged even when stopped | ~$1.60 |
| Elastic IP | Free while attached to a running instance | $0 |
| Data transfer | Minimal for personal/demo use | <$1 |
| **Total (always on)** | | **~$33/month** |
| **Total (stopped when idle)** | e.g., 4 hrs/day × 30 days | **~$6/month** |

---

## IAM Permissions the Scanning User Needs

The AWS credentials you enter in the dashboard need at least these permissions. In AWS Console → IAM → Users → your user → Add permissions → Create inline policy → paste this JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ACAReadOnly",
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
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ACASecurityGroupRemediation",
      "Effect": "Allow",
      "Action": [
        "ec2:RevokeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupIngress"
      ],
      "Resource": "*"
    }
  ]
}
```

For the **Terraform apply** feature (creates/modifies real AWS resources), the user will also need EC2, S3, IAM, or VPC write permissions depending on what the generated Terraform code does.

---

## Troubleshooting

**Browser shows "connection refused" or times out on port 80**
- Go to EC2 → Security Groups → your instance's group → Inbound rules → confirm port 80 is open to `0.0.0.0/0`
- Run `docker compose ps` — both containers must show `running`
- Run `docker compose logs frontend` to check for Nginx errors

**`docker compose up` fails with out-of-memory error**
- Sentence-Transformers loads a ~90 MB model. You need at least 4 GB RAM.
- `t2.micro` (1 GB free tier) is not enough. Use `t3.medium` minimum.

**Backend health check fails / container keeps restarting**
- Run `docker compose logs backend` — look for the error message
- Common causes: missing or malformed `.env` file, invalid Groq API key

**AWS scan returns "Access Denied" or "InvalidClientTokenId"**
- Double-check the Access Key and Secret Key in the dashboard settings
- Make sure the IAM user has the permissions listed above
- Check the region matches where your resources live

**Terraform commands fail with "terraform: not found"**
- Terraform is installed during `docker compose build`. Rebuild: `docker compose up -d --build`

**`git clone` fails for a private repo**
- Use a Personal Access Token: `git clone https://YOUR_TOKEN@github.com/YOUR_USERNAME/ACA-MCP.git`

---

## File Layout on the Server

```
~/ACA-MCP/
├── backend/.env              ← your API keys — never commit this file
├── docker-compose.yml        ← starts both containers
├── backend/
│   ├── main.py               ← FastAPI entry point
│   ├── mcp_server.py         ← all 30+ MCP tools defined here
│   ├── services/             ← AWS scanning, LLM, Terraform, security logic
│   └── requirements.txt
├── frontend/
│   ├── src/                  ← React source
│   └── nginx.conf            ← Nginx reverse-proxy config
└── (created at runtime)
    ├── chroma_db/            ← ChromaDB vector store (Docker volume)
    └── terraform_workdirs/   ← per-execution Terraform files (Docker volume)
```

---

*ACA-MCP Deployment Guide | Mihir | May 2026*
