"""Append-only JSONL usage event log for ACA's model recommender.

Schema per line:
  {timestamp, action_type, model_used, scan_size_bucket}

action_type  ∈ {"chat", "security_analysis", "cost_recommendation",
                "terraform_generation", "agent_run"}
scan_size_bucket ∈ {"none", "small", "medium", "large"}
  none   — no scan_data supplied
  small  — total resources < 5
  medium — 5–25
  large  — > 25
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

_DATA_DIR = Path(__file__).parent / "data"
_LOG_FILE = _DATA_DIR / "usage_events.jsonl"


def _compute_scan_size_bucket(scan_data: dict | None) -> str:
    if not scan_data:
        return "none"
    total = (
        scan_data.get("ec2", {}).get("count", 0)
        + scan_data.get("s3", {}).get("count", 0)
        + scan_data.get("iam", {}).get("user_count", 0)
        + scan_data.get("security_groups", {}).get("count", 0)
        + scan_data.get("vpc", {}).get("count", 0)
    )
    if total == 0:
        return "none"
    if total < 5:
        return "small"
    if total <= 25:
        return "medium"
    return "large"


def log_event(
    action_type: str,
    model_used: str | None,
    scan_data: dict | None,
) -> None:
    """Append one event to the JSONL log. Never raises."""
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "action_type": action_type,
            "model_used": model_used,
            "scan_size_bucket": _compute_scan_size_bucket(scan_data),
        }
        with open(_LOG_FILE, "a") as fh:
            fh.write(json.dumps(event) + "\n")
    except Exception:
        pass


def recent_events(limit: int = 50) -> list[dict]:
    """Return the most recent `limit` events, oldest first."""
    try:
        if not _LOG_FILE.exists():
            return []
        events: list[dict] = []
        with open(_LOG_FILE) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        return events[-limit:]
    except Exception:
        return []


def _parse_ts(ts: str) -> datetime:
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return datetime.min.replace(tzinfo=timezone.utc)


def usage_summary(window_hours: int = 24) -> dict:
    """Aggregate events within the rolling window.

    Returns:
        {
          "action_counts": {"chat": 5, "security_analysis": 2, ...},
          "dominant_action": "security_analysis",
          "dominant_scan_size": "large",
          "total_events": 7
        }
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    events = [
        e for e in recent_events(limit=10_000)
        if _parse_ts(e.get("timestamp", "")) >= cutoff
    ]

    action_counts: dict[str, int] = {}
    bucket_counts: dict[str, int] = {}
    for e in events:
        act = e.get("action_type", "")
        if act:
            action_counts[act] = action_counts.get(act, 0) + 1
        bkt = e.get("scan_size_bucket", "")
        if bkt:
            bucket_counts[bkt] = bucket_counts.get(bkt, 0) + 1

    dominant_action = max(action_counts, key=action_counts.__getitem__) if action_counts else None
    dominant_scan_size = max(bucket_counts, key=bucket_counts.__getitem__) if bucket_counts else "none"

    return {
        "action_counts": action_counts,
        "dominant_action": dominant_action,
        "dominant_scan_size": dominant_scan_size,
        "total_events": len(events),
    }
