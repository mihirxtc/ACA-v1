CLOUD_MODELS = [
    {
        "id": "gpt-oss:20b-cloud",
        "label": "gpt-oss 20B (Cloud)",
        "description": "Fast general-purpose model. Lowest latency. Recommended default.",
        "recommended_for": "default",
    },
    {
        "id": "gpt-oss:120b-cloud",
        "label": "gpt-oss 120B (Cloud)",
        "description": "Higher reasoning quality. Better for complex AWS scan analysis.",
        "recommended_for": "analysis",
    },
    {
        "id": "qwen3-coder:480b-cloud",
        "label": "Qwen3 Coder 480B (Cloud)",
        "description": "Specialized for code and IaC generation. Best for Terraform output.",
        "recommended_for": "iac",
    },
]

DEFAULT_MODEL = "gpt-oss:20b-cloud"
