"""
Tests for probe_ollama in services/ollama_service.py.

Run with:
    cd backend
    python -m pytest tests/test_ollama_status.py -v
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from services.ollama_service import probe_ollama


def _mock_response(status: int, body: dict) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.json.return_value = body
    return resp


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Case 1: Ollama reachable with installed models
# ---------------------------------------------------------------------------

def test_probe_ollama_reachable():
    version_resp = _mock_response(200, {"version": "0.3.12"})
    tags_resp = _mock_response(200, {
        "models": [
            {
                "name": "llama3.2:3b",
                "size": 2019393189,
                "modified_at": "2024-11-15T10:00:00Z",
            }
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

    assert result["reachable"] is True
    assert result["version"] == "0.3.12"
    assert result["error"] is None
    assert len(result["models"]) == 1
    assert result["models"][0]["name"] == "llama3.2:3b"
    assert result["models"][0]["size_gb"] == 2.0
    assert result["base_url"] == "http://localhost:11434"


# ---------------------------------------------------------------------------
# Case 2: Ollama daemon not running (ConnectError)
# ---------------------------------------------------------------------------

def test_probe_ollama_unreachable():
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

    async def run():
        with patch("services.ollama_service.httpx.AsyncClient") as MockClient:
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
            return await probe_ollama("http://localhost:11434")

    result = _run(run())

    assert result["reachable"] is False
    assert result["version"] is None
    assert result["models"] == []
    assert result["error"] == "ConnectError"


# ---------------------------------------------------------------------------
# Case 3: Ollama running but no models installed
# ---------------------------------------------------------------------------

def test_probe_ollama_empty_models():
    version_resp = _mock_response(200, {"version": "0.3.12"})
    tags_resp = _mock_response(200, {"models": []})

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=[version_resp, tags_resp])

    async def run():
        with patch("services.ollama_service.httpx.AsyncClient") as MockClient:
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
            return await probe_ollama("http://localhost:11434")

    result = _run(run())

    assert result["reachable"] is True
    assert result["version"] == "0.3.12"
    assert result["models"] == []
    assert result["error"] is None
