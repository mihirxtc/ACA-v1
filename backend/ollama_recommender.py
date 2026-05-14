"""Hybrid model recommender for ACA's Ollama integration.

Decision: Rule-based weighted scoring across four features (task fit,
scan size fit, latency fit, recency boost). Weights and feature values
are disclosed in this module's constants for auditability.

Explanation: LLM-generated rationale (Claude/Groq) layered over scorer
output, with deterministic template fallback when no LLM key is
configured. The LLM never overrides the scorer's ranking.

See evaluation chapter for weight derivation and acceptance-rate
analysis from usage_log.py event data.
"""

import asyncio
import functools
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Scoring tables — top-level constants for auditability
# ---------------------------------------------------------------------------

TASK_FIT = {
    ("gpt-oss:20b-cloud", "chat"): 0.95,
    ("gpt-oss:20b-cloud", "security"): 0.55,
    ("gpt-oss:20b-cloud", "iac"): 0.35,
    ("gpt-oss:20b-cloud", "agent"): 0.65,
    ("gpt-oss:120b-cloud", "chat"): 0.80,
    ("gpt-oss:120b-cloud", "security"): 0.95,
    ("gpt-oss:120b-cloud", "iac"): 0.70,
    ("gpt-oss:120b-cloud", "agent"): 0.95,
    ("qwen3-coder:480b-cloud", "chat"): 0.45,
    ("qwen3-coder:480b-cloud", "security"): 0.60,
    ("qwen3-coder:480b-cloud", "iac"): 0.95,
    ("qwen3-coder:480b-cloud", "agent"): 0.75,
}

SCAN_SIZE_FIT = {
    ("gpt-oss:20b-cloud", "none"): 0.90,
    ("gpt-oss:20b-cloud", "small"): 0.85,
    ("gpt-oss:20b-cloud", "medium"): 0.60,
    ("gpt-oss:20b-cloud", "large"): 0.40,
    ("gpt-oss:120b-cloud", "none"): 0.75,
    ("gpt-oss:120b-cloud", "small"): 0.85,
    ("gpt-oss:120b-cloud", "medium"): 0.95,
    ("gpt-oss:120b-cloud", "large"): 0.95,
    ("qwen3-coder:480b-cloud", "none"): 0.55,
    ("qwen3-coder:480b-cloud", "small"): 0.60,
    ("qwen3-coder:480b-cloud", "medium"): 0.75,
    ("qwen3-coder:480b-cloud", "large"): 0.80,
}

LATENCY_FIT = {
    ("gpt-oss:20b-cloud", "fast"): 0.95,
    ("gpt-oss:20b-cloud", "balanced"): 0.75,
    ("gpt-oss:20b-cloud", "quality"): 0.40,
    ("gpt-oss:120b-cloud", "fast"): 0.50,
    ("gpt-oss:120b-cloud", "balanced"): 0.90,
    ("gpt-oss:120b-cloud", "quality"): 0.85,
    ("qwen3-coder:480b-cloud", "fast"): 0.30,
    ("qwen3-coder:480b-cloud", "balanced"): 0.65,
    ("qwen3-coder:480b-cloud", "quality"): 0.95,
}

WEIGHTS = {
    "task_fit": 0.40,
    "scan_size_fit": 0.25,
    "latency_fit": 0.20,
    "recency_boost": 0.15,
}

_FEATURE_LABELS = {
    "task_fit": "task alignment",
    "scan_size_fit": "scan size handling",
    "latency_fit": "response speed",
    "recency_boost": "recent usage patterns",
}

_TASK_DESCRIPTIONS = {
    "chat": "general AWS chat",
    "security": "security analysis",
    "iac": "infrastructure-as-code generation",
    "agent": "autonomous agent tasks",
}

_SCAN_SIZE_DESCRIPTIONS = {
    "none": "no infrastructure scan",
    "small": "small infrastructure scans",
    "medium": "medium infrastructure scans",
    "large": "large infrastructure scans",
}


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class RecommendContext:
    primary_use: str        # "chat" | "security" | "iac" | "agent"
    latency_pref: str       # "fast" | "balanced" | "quality"
    scan_size_bucket: str   # "none" | "small" | "medium" | "large"
    dominant_recent_action: str | None
    history_event_count: int


@dataclass
class Recommendation:
    model_id: str
    score: float
    rank: int
    feature_breakdown: dict
    template_explanation: str


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_model(model_id: str, context: RecommendContext) -> tuple[float, dict]:
    """Return (final_score, breakdown) where breakdown shows each feature's weighted contribution."""
    raw_task = TASK_FIT.get((model_id, context.primary_use), 0.5)
    raw_scan = SCAN_SIZE_FIT.get((model_id, context.scan_size_bucket), 0.5)
    raw_latency = LATENCY_FIT.get((model_id, context.latency_pref), 0.5)

    # Recency boost: model matches dominant recent action
    _action_to_task = {
        "chat": "chat",
        "security_analysis": "security",
        "terraform_generation": "iac",
        "cost_recommendation": "iac",
        "agent_run": "agent",
    }
    dominant_task = _action_to_task.get(context.dominant_recent_action or "", None)
    raw_recency = TASK_FIT.get((model_id, dominant_task), 0.5) if dominant_task else 0.5

    # Scale down recency weight when history is thin (< 3 events)
    w = dict(WEIGHTS)
    if context.history_event_count < 3:
        scale = context.history_event_count / 3.0
        deficit = w["recency_boost"] * (1.0 - scale)
        w["recency_boost"] = w["recency_boost"] * scale
        # Redistribute deficit equally across the other three features
        per_feature = deficit / 3.0
        w["task_fit"] += per_feature
        w["scan_size_fit"] += per_feature
        w["latency_fit"] += per_feature

    breakdown = {
        "task_fit": raw_task * w["task_fit"],
        "scan_size_fit": raw_scan * w["scan_size_fit"],
        "latency_fit": raw_latency * w["latency_fit"],
        "recency_boost": raw_recency * w["recency_boost"],
    }
    final_score = sum(breakdown.values())
    return final_score, breakdown


def template_explanation(model_id: str, context: RecommendContext, breakdown: dict) -> str:
    """Generate a plain-English explanation based on the top 2 scoring features."""
    top2 = sorted(breakdown, key=breakdown.__getitem__, reverse=True)[:2]
    top_label = _FEATURE_LABELS.get(top2[0], top2[0])
    second_label = _FEATURE_LABELS.get(top2[1], top2[1])

    task_desc = _TASK_DESCRIPTIONS.get(context.primary_use, context.primary_use)
    scan_desc = _SCAN_SIZE_DESCRIPTIONS.get(context.scan_size_bucket, context.scan_size_bucket)

    return (
        f"Optimised for {task_desc} with strong {second_label} for {scan_desc}. "
        f"Selected based on {top_label} and {second_label}."
    )


def recommend(context: RecommendContext, catalog: list) -> list[Recommendation]:
    """Score all models, sort descending, assign ranks 1/2/3. Always returns all three."""
    scored = []
    for model in catalog:
        model_id = model if isinstance(model, str) else model.get("id", str(model))
        score, breakdown = score_model(model_id, context)
        expl = template_explanation(model_id, context, breakdown)
        scored.append((score, model_id, breakdown, expl))

    scored.sort(key=lambda x: x[0], reverse=True)

    return [
        Recommendation(
            model_id=model_id,
            score=round(score, 4),
            rank=i + 1,
            feature_breakdown=breakdown,
            template_explanation=expl,
        )
        for i, (score, model_id, breakdown, expl) in enumerate(scored)
    ]


# ---------------------------------------------------------------------------
# LLM explanation layer (Phase 5.3)
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=128)
def _cached_explanation_key(
    model_id: str,
    primary_use: str,
    latency_pref: str,
    scan_size_bucket: str,
) -> str:
    """Cache key tuple — recency_boost intentionally excluded."""
    return f"{model_id}:{primary_use}:{latency_pref}:{scan_size_bucket}"


_explanation_cache: dict[str, str] = {}


async def llm_explanation(
    rec: Recommendation,
    context: RecommendContext,
    anthropic_key: str | None,
    groq_key: str | None,
) -> str:
    cache_key = _cached_explanation_key(
        rec.model_id, context.primary_use, context.latency_pref, context.scan_size_bucket
    )
    if cache_key in _explanation_cache:
        return _explanation_cache[cache_key]

    if not anthropic_key and not groq_key:
        return rec.template_explanation

    top2 = sorted(rec.feature_breakdown, key=rec.feature_breakdown.__getitem__, reverse=True)[:2]
    top2_readable = ", ".join(_FEATURE_LABELS.get(f, f) for f in top2)

    prompt = (
        f"You are writing a 2-sentence recommendation rationale (max 40 words total) "
        f"for a cloud infrastructure tool. The user's primary use is {context.primary_use}, "
        f"latency preference is {context.latency_pref}, scan size is {context.scan_size_bucket}. "
        f"The top contributing features for recommending {rec.model_id} are: {top2_readable}. "
        f"Write 2 sentences. Be specific, avoid marketing language."
    )

    result = None
    try:
        if anthropic_key:
            result = await _call_anthropic(prompt, anthropic_key)
        elif groq_key:
            result = await _call_groq(prompt, groq_key)
    except Exception as exc:
        logger.warning("llm_explanation failed for %s: %s", rec.model_id, exc)
        return rec.template_explanation

    if result:
        _explanation_cache[cache_key] = result
        return result
    return rec.template_explanation


async def _call_anthropic(prompt: str, api_key: str) -> str:
    import urllib.request
    import json as _json

    payload = _json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 150,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )

    loop = asyncio.get_event_loop()

    def _do_request():
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            return _json.loads(resp.read())

    data = await asyncio.wait_for(loop.run_in_executor(None, _do_request), timeout=5.0)
    return data["content"][0]["text"].strip()


async def _call_groq(prompt: str, api_key: str) -> str:
    import urllib.request
    import json as _json

    payload = _json.dumps({
        "model": "llama3-8b-8192",
        "max_tokens": 150,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()

    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
        method="POST",
    )

    loop = asyncio.get_event_loop()

    def _do_request():
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            return _json.loads(resp.read())

    data = await asyncio.wait_for(loop.run_in_executor(None, _do_request), timeout=5.0)
    return data["choices"][0]["message"]["content"].strip()
