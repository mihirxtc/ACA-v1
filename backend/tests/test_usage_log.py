"""
Tests for backend/usage_log.py.

Run with:
    cd backend
    python -m pytest tests/test_usage_log.py -v
"""

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
from pathlib import Path

import pytest
import usage_log


# ---------------------------------------------------------------------------
# Fixture: redirect the log to a temp file for each test
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def isolated_log(tmp_path, monkeypatch):
    """Each test gets its own empty JSONL log in a temp directory."""
    monkeypatch.setattr(usage_log, "_DATA_DIR", tmp_path)
    monkeypatch.setattr(usage_log, "_LOG_FILE", tmp_path / "usage_events.jsonl")


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _read_raw(tmp_path) -> list[dict]:
    p = tmp_path / "usage_events.jsonl"
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


# ---------------------------------------------------------------------------
# test_log_and_retrieve
# ---------------------------------------------------------------------------

def test_log_and_retrieve(tmp_path):
    usage_log.log_event("chat", "groq", None)
    usage_log.log_event("security_analysis", "anthropic", {"ec2": {"count": 3}})
    usage_log.log_event("terraform_generation", "gpt-oss:20b-cloud", {"ec2": {"count": 10}})

    events = usage_log.recent_events()

    assert len(events) == 3, f"expected 3 events, got {len(events)}"

    # Ordering: oldest → newest
    assert events[0]["action_type"] == "chat"
    assert events[1]["action_type"] == "security_analysis"
    assert events[2]["action_type"] == "terraform_generation"

    # Required fields on every event
    for e in events:
        assert "timestamp" in e
        assert "action_type" in e
        assert "model_used" in e
        assert "scan_size_bucket" in e

    # Bucket computation
    assert events[0]["scan_size_bucket"] == "none"    # scan_data=None
    assert events[1]["scan_size_bucket"] == "small"   # 3 resources < 5
    assert events[2]["scan_size_bucket"] == "medium"  # 10 resources, 5-25


# ---------------------------------------------------------------------------
# test_summary_counts_correctly
# ---------------------------------------------------------------------------

def test_summary_counts_correctly():
    # 3 security_analysis with medium scans
    for _ in range(3):
        usage_log.log_event("security_analysis", "groq", {"ec2": {"count": 20}})
    # 2 chats with no scan
    for _ in range(2):
        usage_log.log_event("chat", "groq", None)
    # 1 terraform with large scan
    usage_log.log_event("terraform_generation", "anthropic", {
        "ec2": {"count": 15},
        "s3": {"count": 8},
        "iam": {"user_count": 5},
    })

    summary = usage_log.usage_summary()

    assert summary["action_counts"]["security_analysis"] == 3
    assert summary["action_counts"]["chat"] == 2
    assert summary["action_counts"]["terraform_generation"] == 1
    assert summary["dominant_action"] == "security_analysis"
    assert summary["total_events"] == 6

    # dominant_scan_size: "medium" appears 3 times, "none" 2 times, "large" 1 time
    assert summary["dominant_scan_size"] == "medium"


# ---------------------------------------------------------------------------
# test_log_failure_swallowed
# ---------------------------------------------------------------------------

def test_log_failure_swallowed(monkeypatch):
    """A broken file write must not propagate — log_event returns None silently."""
    def _boom(*args, **kwargs):
        raise OSError("disk full — simulated")

    monkeypatch.setattr("builtins.open", _boom)

    result = usage_log.log_event("chat", "groq", None)
    assert result is None   # explicit None, no exception raised


# ---------------------------------------------------------------------------
# test_scan_size_buckets (boundary checks)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("scan_data,expected", [
    (None, "none"),
    ({}, "none"),
    ({"ec2": {"count": 0}}, "none"),
    ({"ec2": {"count": 1}}, "small"),
    ({"ec2": {"count": 4}}, "small"),
    ({"ec2": {"count": 5}}, "medium"),
    ({"ec2": {"count": 25}}, "medium"),
    ({"ec2": {"count": 26}}, "large"),
    (
        {"ec2": {"count": 10}, "s3": {"count": 10},
         "iam": {"user_count": 10}},
        "large",
    ),
])
def test_scan_size_buckets(scan_data, expected):
    usage_log.log_event("chat", "groq", scan_data)
    events = usage_log.recent_events()
    assert events[-1]["scan_size_bucket"] == expected, \
        f"scan_data={scan_data!r} → expected {expected!r}, got {events[-1]['scan_size_bucket']!r}"


# ---------------------------------------------------------------------------
# test_recent_events_limit
# ---------------------------------------------------------------------------

def test_recent_events_limit():
    for i in range(10):
        usage_log.log_event("chat", "groq", None)

    assert len(usage_log.recent_events(limit=5)) == 5
    assert len(usage_log.recent_events(limit=3)) == 3
    # limit=5 returns the 5 most recent (tail of file)
    all_events = usage_log.recent_events(limit=100)
    limited = usage_log.recent_events(limit=5)
    assert limited == all_events[-5:]


# ---------------------------------------------------------------------------
# test_empty_log_returns_safe_defaults
# ---------------------------------------------------------------------------

def test_empty_log_returns_safe_defaults():
    events = usage_log.recent_events()
    assert events == []

    summary = usage_log.usage_summary()
    assert summary["total_events"] == 0
    assert summary["dominant_action"] is None
    assert summary["dominant_scan_size"] == "none"
    assert summary["action_counts"] == {}
