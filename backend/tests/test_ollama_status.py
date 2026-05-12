"""
Tests for probe_ollama and stream_ollama_pull in services/ollama_service.py.

Run with:
    cd backend
    python -m pytest tests/test_ollama_status.py -v
"""

import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from ollama_catalog import CLOUD_MODELS, DEFAULT_MODEL
from services.ollama_service import probe_ollama, stream_ollama_pull

_CATALOG_IDS = {m["id"] for m in CLOUD_MODELS}


def _mock_response(status: int, body: dict) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.json.return_value = body
    return resp


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Case 1: Ollama reachable with a catalog model installed → state "ready"
# ---------------------------------------------------------------------------

def test_probe_ollama_ready():
    version_resp = _mock_response(200, {"version": "0.3.12"})
    tags_resp = _mock_response(200, {
        "models": [
            {"name": "gpt-oss:20b-cloud", "size": 0, "modified_at": "2025-01-01T00:00:00Z"},
        ]
    })

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=[version_resp, tags_resp])

    async def run():
        with patch("services.ollama_service.httpx.AsyncClient") as MockClient:
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
            return await probe_ollama("http://localhost:11434")

    result = _run(run())

    assert result["state"] == "ready"
    assert result["version"] == "0.3.12"
    assert result["error_code"] is None
    assert result["base_url"] == "http://localhost:11434"
    assert len(result["installed_models"]) == 1
    assert result["installed_models"][0]["id"] == "gpt-oss:20b-cloud"
    assert result["installed_models"][0]["label"] == "gpt-oss 20B (Cloud)"
    # Other catalog models appear as available
    available_ids = {m["id"] for m in result["available_models"]}
    assert "gpt-oss:20b-cloud" not in available_ids
    assert "gpt-oss:120b-cloud" in available_ids
    assert "qwen3-coder:480b-cloud" in available_ids


# ---------------------------------------------------------------------------
# Case 2: Ollama daemon not running → state "unavailable"
# ---------------------------------------------------------------------------

def test_probe_ollama_unavailable():
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

    async def run():
        with patch("services.ollama_service.httpx.AsyncClient") as MockClient:
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
            return await probe_ollama("http://localhost:11434")

    result = _run(run())

    assert result["state"] == "unavailable"
    assert result["version"] is None
    assert result["installed_models"] == []
    assert result["error_code"] == "ConnectError"
    # Full catalog offered as available so UI can show install options
    assert len(result["available_models"]) == len(CLOUD_MODELS)


# ---------------------------------------------------------------------------
# Case 3: Ollama running but no catalog models installed → state "no_models"
# ---------------------------------------------------------------------------

def test_probe_ollama_no_catalog_models():
    version_resp = _mock_response(200, {"version": "0.3.12"})
    # Tags returns a non-catalog model (e.g. user has llama3.2:3b locally)
    tags_resp = _mock_response(200, {"models": [{"name": "llama3.2:3b", "size": 0}]})

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=[version_resp, tags_resp])

    async def run():
        with patch("services.ollama_service.httpx.AsyncClient") as MockClient:
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
            return await probe_ollama("http://localhost:11434")

    result = _run(run())

    assert result["state"] == "no_models"
    assert result["version"] == "0.3.12"
    assert result["installed_models"] == []
    assert len(result["available_models"]) == len(CLOUD_MODELS)
    assert result["error_code"] is None


# ---------------------------------------------------------------------------
# Case 4: stream_ollama_pull detects auth error and appends synthetic event
# ---------------------------------------------------------------------------

def test_stream_pull_auth_error():
    lines_from_ollama = [
        json.dumps({"status": "pulling manifest"}),
        json.dumps({"error": "unauthorized: please sign in to access this model"}),
    ]

    async def mock_aiter_lines():
        for line in lines_from_ollama:
            yield line

    mock_response = MagicMock()
    mock_response.aiter_lines = mock_aiter_lines

    async def run():
        collected = []
        with patch("services.ollama_service.httpx.AsyncClient") as MockClient:
            mock_http = AsyncMock()
            mock_http.__aenter__ = AsyncMock(return_value=mock_response)
            mock_http.__aexit__ = AsyncMock(return_value=False)
            mock_client_inst = AsyncMock()
            mock_client_inst.stream = MagicMock(return_value=mock_http)
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client_inst)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
            async for chunk in stream_ollama_pull("http://localhost:11434", "gpt-oss:20b-cloud"):
                collected.append(json.loads(chunk.strip()))
        return collected

    chunks = _run(run())

    statuses = [c.get("status") for c in chunks]
    assert "auth_required" in statuses, f"Expected auth_required in {statuses}"

    auth_chunk = next(c for c in chunks if c.get("status") == "auth_required")
    assert "ollama signin" in auth_chunk["message"]


# ---------------------------------------------------------------------------
# Case 5: chat_with_ollama raises ValueError for non-catalog model
# ---------------------------------------------------------------------------

def test_chat_with_ollama_rejects_non_catalog_model():
    from services.llm_service import chat_with_ollama

    async def run():
        return await chat_with_ollama(
            message="hi",
            scan_data={},
            model_name="llama3.2:3b",   # not in catalog
        )

    with pytest.raises(ValueError, match="not in the Ollama cloud catalog"):
        _run(run())


def test_chat_with_ollama_default_is_catalog_model():
    import inspect
    from services.llm_service import chat_with_ollama
    sig = inspect.signature(chat_with_ollama)
    default = sig.parameters["model_name"].default
    assert default == DEFAULT_MODEL
    assert default in _CATALOG_IDS
