export const CLOUD_MODELS = [
  {
    id: 'gpt-oss:20b-cloud',
    label: 'gpt-oss 20B (Cloud)',
    description: 'Fast general-purpose model. Lowest latency. Recommended default.',
    recommended_for: 'default',
  },
  {
    id: 'gpt-oss:120b-cloud',
    label: 'gpt-oss 120B (Cloud)',
    description: 'Higher reasoning quality. Better for complex AWS scan analysis.',
    recommended_for: 'analysis',
  },
  {
    id: 'qwen3-coder:480b-cloud',
    label: 'Qwen3 Coder 480B (Cloud)',
    description: 'Specialized for code and IaC generation. Best for Terraform output.',
    recommended_for: 'iac',
  },
]

export const DEFAULT_MODEL = 'gpt-oss:20b-cloud'

export const TASK_FIT = {
  'gpt-oss:20b-cloud:chat': 0.95,
  'gpt-oss:20b-cloud:security': 0.55,
  'gpt-oss:20b-cloud:iac': 0.35,
  'gpt-oss:20b-cloud:agent': 0.65,
  'gpt-oss:120b-cloud:chat': 0.80,
  'gpt-oss:120b-cloud:security': 0.95,
  'gpt-oss:120b-cloud:iac': 0.70,
  'gpt-oss:120b-cloud:agent': 0.95,
  'qwen3-coder:480b-cloud:chat': 0.45,
  'qwen3-coder:480b-cloud:security': 0.60,
  'qwen3-coder:480b-cloud:iac': 0.95,
  'qwen3-coder:480b-cloud:agent': 0.75,
}

export const SCAN_SIZE_FIT = {
  'gpt-oss:20b-cloud:none': 0.90,
  'gpt-oss:20b-cloud:small': 0.85,
  'gpt-oss:20b-cloud:medium': 0.60,
  'gpt-oss:20b-cloud:large': 0.40,
  'gpt-oss:120b-cloud:none': 0.75,
  'gpt-oss:120b-cloud:small': 0.85,
  'gpt-oss:120b-cloud:medium': 0.95,
  'gpt-oss:120b-cloud:large': 0.95,
  'qwen3-coder:480b-cloud:none': 0.55,
  'qwen3-coder:480b-cloud:small': 0.60,
  'qwen3-coder:480b-cloud:medium': 0.75,
  'qwen3-coder:480b-cloud:large': 0.80,
}

export const LATENCY_FIT = {
  'gpt-oss:20b-cloud:fast': 0.95,
  'gpt-oss:20b-cloud:balanced': 0.75,
  'gpt-oss:20b-cloud:quality': 0.40,
  'gpt-oss:120b-cloud:fast': 0.50,
  'gpt-oss:120b-cloud:balanced': 0.90,
  'gpt-oss:120b-cloud:quality': 0.85,
  'qwen3-coder:480b-cloud:fast': 0.30,
  'qwen3-coder:480b-cloud:balanced': 0.65,
  'qwen3-coder:480b-cloud:quality': 0.95,
}

export const WEIGHTS = {
  task_fit: 0.40,
  scan_size_fit: 0.25,
  latency_fit: 0.20,
  recency_boost: 0.15,
}
