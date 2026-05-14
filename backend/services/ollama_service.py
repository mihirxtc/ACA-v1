import json
import os
import pathlib

import httpx

from ollama_catalog import CLOUD_MODELS

_CATALOG_IDS = {m["id"] for m in CLOUD_MODELS}

# Pre-built catalog entries keyed by id, preserving list order for responses
_CATALOG_ENTRIES = [
    {"id": m["id"], "label": m["label"], "description": m["description"]}
    for m in CLOUD_MODELS
]

_OLLAMA_CREDENTIAL_PATHS = [
    pathlib.Path.home() / ".ollama" / "id_ed25519",      # SSH key — written by `ollama signin`
    pathlib.Path.home() / ".ollama" / "credentials",
    pathlib.Path.home() / ".ollama" / "token",
]


def _ollama_signed_in() -> bool:
    """Return True if an Ollama auth credential exists on disk.

    `ollama signin` writes an SSH key pair to ~/.ollama/id_ed25519.
    Its presence (non-empty) is the reliable signal the user is authenticated.
    """
    for path in _OLLAMA_CREDENTIAL_PATHS:
        try:
            if path.exists() and path.stat().st_size > 0:
                return True
        except OSError:
            pass
    return False


async def probe_ollama(base_url: str = "http://localhost:11434") -> dict:
    """Probe an Ollama instance and return structured cloud-model status.

    Filters installed models against the CLOUD_MODELS catalog only.
    Never raises.

    Returns:
        {
          "state": "ready" | "no_models" | "unavailable",
          "base_url": str,
          "version": str | null,
          "installed_models": [{"id", "label", "description"}],
          "available_models": [{"id", "label", "description"}],
          "error_code": str | null,
        }
    """
    base_url = base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            version_resp = await client.get(f"{base_url}/api/version")
            version = (
                version_resp.json().get("version")
                if version_resp.status_code == 200
                else None
            )

            installed_ids = set()
            tags_resp = await client.get(f"{base_url}/api/tags")
            if tags_resp.status_code == 200:
                for m in tags_resp.json().get("models", []):
                    name = m.get("name", "")
                    if name:
                        installed_ids.add(name)

        _catalog_by_id = {e["id"]: e for e in _CATALOG_ENTRIES}
        installed_models = []
        for mid in installed_ids:
            if mid in _catalog_by_id:
                installed_models.append(_catalog_by_id[mid])
            else:
                installed_models.append({"id": mid, "label": mid, "description": "Locally installed model"})
        installed_models.sort(key=lambda e: e["id"])
        available_models = [e for e in _CATALOG_ENTRIES if e["id"] not in installed_ids]
        state = "ready" if installed_models else "no_models"

        signed_in = _ollama_signed_in()
        return {
            "state": state,
            "base_url": base_url,
            "version": version,
            "signed_in": signed_in,
            "installed_models": installed_models,
            "available_models": available_models,
            "error_code": None,
        }
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        return {
            "state": "unavailable",
            "base_url": base_url,
            "version": None,
            "signed_in": _ollama_signed_in(),
            "installed_models": [],
            "available_models": list(_CATALOG_ENTRIES),
            "error_code": type(e).__name__,
        }
    except Exception as e:
        return {
            "state": "unavailable",
            "base_url": base_url,
            "version": None,
            "signed_in": _ollama_signed_in(),
            "installed_models": [],
            "available_models": list(_CATALOG_ENTRIES),
            "error_code": str(e),
        }


_AUTH_KEYWORDS = ("unauthorized", "sign in", "auth")


async def stream_ollama_pull(base_url: str, model: str):
    """Async generator that streams JSONL pull-progress lines from Ollama.

    Passes all chunks through unchanged. If an error chunk containing auth
    keywords is detected, appends a synthesized auth_required event so the
    frontend can surface a clean message instead of raw Ollama error text.
    """
    base_url = base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", f"{base_url}/api/pull", json={"name": model}
            ) as response:
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    yield line + "\n"
                    try:
                        chunk = json.loads(line)
                        err_text = chunk.get("error", "").lower()
                        if err_text and any(kw in err_text for kw in _AUTH_KEYWORDS):
                            yield json.dumps({
                                "status": "auth_required",
                                "message": "Run `ollama signin` in a terminal to access cloud models, then retry.",
                            }) + "\n"
                    except (json.JSONDecodeError, AttributeError):
                        pass
    except Exception as e:
        yield json.dumps({"error": str(e)}) + "\n"
