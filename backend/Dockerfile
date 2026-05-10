FROM python:3.11-slim

# Install system deps: curl for health checks, unzip for Terraform
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Terraform — detect CPU architecture so the build works on both
# x86_64 (standard EC2) and arm64 (Graviton EC2 / Apple Silicon)
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then TF_ARCH="amd64"; \
       elif [ "$ARCH" = "arm64" ]; then TF_ARCH="arm64"; \
       else echo "Unsupported architecture: $ARCH" && exit 1; fi \
    && curl -fsSL https://releases.hashicorp.com/terraform/1.8.5/terraform_1.8.5_linux_${TF_ARCH}.zip \
       -o /tmp/terraform.zip \
    && unzip /tmp/terraform.zip -d /usr/local/bin/ \
    && rm /tmp/terraform.zip \
    && terraform version

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# chroma_db and terraform_workdirs are mounted as volumes at runtime
RUN mkdir -p /app/chroma_db /app/terraform_workdirs

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
