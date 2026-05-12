"""Tests for backend/ollama_recommender.py — Phase 5.2."""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from ollama_recommender import (
    RecommendContext,
    Recommendation,
    recommend,
    score_model,
    template_explanation,
    TASK_FIT,
    SCAN_SIZE_FIT,
    LATENCY_FIT,
    WEIGHTS,
)

CATALOG = ["gpt-oss:20b-cloud", "gpt-oss:120b-cloud", "qwen3-coder:480b-cloud"]


def _ctx(**kwargs):
    defaults = dict(
        primary_use="chat",
        latency_pref="balanced",
        scan_size_bucket="none",
        dominant_recent_action=None,
        history_event_count=10,
    )
    defaults.update(kwargs)
    return RecommendContext(**defaults)


# ---------------------------------------------------------------------------
# test_iac_user_gets_qwen_coder_first
# ---------------------------------------------------------------------------

def test_iac_user_gets_qwen_coder_first():
    ctx = _ctx(primary_use="iac", latency_pref="quality", scan_size_bucket="large")
    recs = recommend(ctx, CATALOG)
    assert recs[0].model_id == "qwen3-coder:480b-cloud", (
        f"Expected qwen3-coder:480b-cloud first, got {recs[0].model_id}"
    )


# ---------------------------------------------------------------------------
# test_fast_chat_user_gets_20b
# ---------------------------------------------------------------------------

def test_fast_chat_user_gets_20b():
    ctx = _ctx(primary_use="chat", latency_pref="fast", scan_size_bucket="none")
    recs = recommend(ctx, CATALOG)
    assert recs[0].model_id == "gpt-oss:20b-cloud", (
        f"Expected gpt-oss:20b-cloud first, got {recs[0].model_id}"
    )


# ---------------------------------------------------------------------------
# test_security_large_scan_gets_120b
# ---------------------------------------------------------------------------

def test_security_large_scan_gets_120b():
    ctx = _ctx(primary_use="security", latency_pref="quality", scan_size_bucket="large")
    recs = recommend(ctx, CATALOG)
    assert recs[0].model_id == "gpt-oss:120b-cloud", (
        f"Expected gpt-oss:120b-cloud first, got {recs[0].model_id}"
    )


# ---------------------------------------------------------------------------
# test_thin_history_reduces_recency_weight
# ---------------------------------------------------------------------------

def test_thin_history_reduces_recency_weight():
    ctx_thin = _ctx(history_event_count=1, dominant_recent_action="security_analysis")
    ctx_full = _ctx(history_event_count=10, dominant_recent_action="security_analysis")

    _, breakdown_thin = score_model("gpt-oss:120b-cloud", ctx_thin)
    _, breakdown_full = score_model("gpt-oss:120b-cloud", ctx_full)

    assert breakdown_thin["recency_boost"] < breakdown_full["recency_boost"], (
        "Thin history should yield lower recency_boost weighted contribution"
    )


# ---------------------------------------------------------------------------
# test_all_three_always_returned
# ---------------------------------------------------------------------------

def test_all_three_always_returned():
    for primary_use in ("chat", "security", "iac", "agent"):
        for latency in ("fast", "balanced", "quality"):
            ctx = _ctx(primary_use=primary_use, latency_pref=latency)
            recs = recommend(ctx, CATALOG)
            assert len(recs) == 3, f"Expected 3 recommendations, got {len(recs)}"
            ranks = [r.rank for r in recs]
            assert ranks == [1, 2, 3], f"Expected ranks [1,2,3], got {ranks}"


# ---------------------------------------------------------------------------
# test_scores_bounded_zero_to_one
# ---------------------------------------------------------------------------

def test_scores_bounded_zero_to_one():
    for model_id in CATALOG:
        for primary_use in ("chat", "security", "iac", "agent"):
            for latency in ("fast", "balanced", "quality"):
                for bucket in ("none", "small", "medium", "large"):
                    for count in (0, 1, 2, 3, 10):
                        ctx = _ctx(
                            primary_use=primary_use,
                            latency_pref=latency,
                            scan_size_bucket=bucket,
                            history_event_count=count,
                        )
                        score, breakdown = score_model(model_id, ctx)
                        assert 0.0 <= score <= 1.0, (
                            f"Score out of bounds: {score} for {model_id}, {ctx}"
                        )
                        for feat, val in breakdown.items():
                            assert val >= 0.0, f"Negative breakdown value: {feat}={val}"


# ---------------------------------------------------------------------------
# test_template_explanation_nonempty_string
# ---------------------------------------------------------------------------

def test_template_explanation_nonempty_string():
    for model_id in CATALOG:
        for primary_use in ("chat", "security", "iac", "agent"):
            ctx = _ctx(primary_use=primary_use)
            _, breakdown = score_model(model_id, ctx)
            expl = template_explanation(model_id, ctx, breakdown)
            assert isinstance(expl, str) and len(expl) > 0, (
                f"template_explanation returned empty/non-string for {model_id}, {primary_use}"
            )
