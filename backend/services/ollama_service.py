import json

import httpx


async def probe_ollama(base_url: str = "http://localhost:11434") -> dict:
    """Probe an Ollama instance and return structured status.

    Tries /api/version (2 s timeout) then /api/tags. Never raises.

    Returns:
        {"reachable", "base_url", "version", "models": [{"name","size_gb","modified_at"}], "error"}
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

            models = []
            tags_resp = await client.get(f"{base_url}/api/tags")
            if tags_resp.status_code == 200:
                for m in tags_resp.json().get("models", []):
                    models.append({
                        "name": m.get("name", ""),
                        "size_gb": round(m.get("size", 0) / 1e9, 1),
                        "modified_at": m.get("modified_at", ""),
                    })

        return {
            "reachable": True,
            "base_url": base_url,
            "version": version,
            "models": models,
            "error": None,
        }
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        return {
            "reachable": False,
            "base_url": base_url,
            "version": None,
            "models": [],
            "error": type(e).__name__,
        }
    except Exception as e:
        return {
            "reachable": False,
            "base_url": base_url,
            "version": None,
            "models": [],
            "error": str(e),
        }


async def stream_ollama_pull(base_url: str, model: str):
    """Async generator that streams JSONL pull-progress lines from Ollama."""
    base_url = base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", f"{base_url}/api/pull", json={"name": model}
            ) as response:
                async for line in response.aiter_lines():
                    if line:
                        yield line + "\n"
    except Exception as e:
        yield json.dumps({"error": str(e)}) + "\n"
