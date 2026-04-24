import json
import os

import httpx
from dotenv import load_dotenv

load_dotenv()


async def chat_with_groq(
    message: str, scan_data: dict, history: list = [], api_key: str = None
) -> str:
    """
    Send a message to the Groq cloud API using the llama-3.3-70b-versatile model.

    The user's AWS infrastructure scan data is injected into the system
    prompt so the LLM can answer questions grounded in real account data.

    Parameters:
        message   (str)  : The user's current question or message.
        scan_data (dict) : The result of a full AWS infrastructure scan.
                           Injected into the system prompt as JSON context.
        history   (list) : Previous conversation turns. Each item must be
                           a dict with 'role' ('user' or 'assistant')
                           and 'content' (str). Defaults to empty list.
        api_key   (str)  : Optional Groq API key supplied by the user at
                           runtime. If provided and non-empty, this key
                           is used instead of the GROQ_API_KEY env var.

    Returns:
        str: The LLM's reply text, or a plain-English error message if
             something goes wrong (never raises an exception to the caller).
    """

    if api_key and api_key.strip():
        resolved_key = api_key.strip()
    else:
        resolved_key = os.getenv("GROQ_API_KEY")

    if not resolved_key:
        return (
            "No Groq API key provided. Please add GROQ_API_KEY to .env "
            "or enter your key in the chat interface."
        )

    system_prompt = (
        "You are an expert AWS cloud management assistant.\n"
        "You have complete visibility into the user's AWS infrastructure.\n"
        "Here is the CURRENT state of their AWS account:\n"
        f"{json.dumps(scan_data, indent=2, default=str)}\n\n"
        "Rules:\n"
        "- Answer ONLY based on the data provided above\n"
        "- Be specific — reference actual resource IDs and names\n"
        "- If something is not in the data, say so clearly\n"
        "- Be concise and helpful"
    )

    messages = [{"role": "system", "content": system_prompt}]
    messages = messages + history
    messages.append({"role": "user", "content": message})

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {resolved_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": messages,
                    "temperature": 0.3,
                    "max_tokens": 1024,
                },
            )

            data = response.json()

            if response.status_code != 200:
                error_message = data.get("error", {}).get("message", str(data))
                return f"Groq API error ({response.status_code}): {error_message}"

            return data["choices"][0]["message"]["content"]

    except Exception as e:
        return f"Error contacting Groq: {str(e)}"


async def chat_with_ollama(
    message: str, scan_data: dict, history: list = [], api_key: str = None
) -> str:
    """
    Send a message to a locally running Ollama instance using minimax-m2.7:cloud.

    Ollama runs entirely on the user's own machine — no data leaves the
    network and no API key is required. This makes it the private/offline
    option in the model selector.

    Parameters:
        message   (str)  : The user's current question or message.
        scan_data (dict) : The result of a full AWS infrastructure scan.
                           Injected into the system prompt as JSON context.
        history   (list) : Previous conversation turns. Each item must be
                           a dict with 'role' ('user' or 'assistant')
                           and 'content' (str). Defaults to empty list.
        api_key   (str)  : Accepted for interface consistency but ignored.
                           Ollama is local and requires no authentication.

    Returns:
        str: The LLM's reply text, or a plain-English error message if
             Ollama is not running or the model is not installed.

    Setup required (one-time):
        ollama serve                  ← start the Ollama daemon
        ollama pull minimax-m2.7:cloud      ← download the model (~4 GB)
    """

    ec2 = scan_data.get("ec2", {})
    s3 = scan_data.get("s3", {})
    iam = scan_data.get("iam", {})
    sgs = scan_data.get("security_groups", {})
    vpc = scan_data.get("vpc", {})

    ec2_summary = [
        {
            "id": i.get("instance_id"),
            "name": i.get("name"),
            "type": i.get("instance_type"),
            "state": i.get("state"),
        }
        for i in ec2.get("instances", [])
    ]

    sg_summary = [
        {
            "id": sg.get("group_id"),
            "name": sg.get("group_name"),
            "is_dangerous": sg.get("is_dangerous"),
        }
        for sg in sgs.get("security_groups", [])
    ]

    iam_summary = [
        {"username": u.get("username"), "mfa_active": u.get("mfa_active")}
        for u in iam.get("users", [])
    ]

    vpc_summary = [
        {
            "id": v.get("vpc_id"),
            "cidr": v.get("cidr_block"),
            "subnet_count": v.get("subnet_count"),
        }
        for v in vpc.get("vpcs", [])
    ]

    compact_summary = {
        "ec2_count": ec2.get("count", 0),
        "ec2_instances": ec2_summary,
        "s3_count": s3.get("count", 0),
        "iam_user_count": iam.get("user_count", 0),
        "iam_users": iam_summary,
        "security_group_count": sgs.get("count", 0),
        "dangerous_sg_count": sum(
            1 for sg in sgs.get("security_groups", []) if sg.get("is_dangerous")
        ),
        "security_groups": sg_summary,
        "vpc_count": vpc.get("count", 0),
        "vpcs": vpc_summary,
    }

    system_prompt = (
        "You are an expert AWS cloud management assistant.\n"
        "You have complete visibility into the user's AWS infrastructure.\n"
        "Here is the CURRENT state of their AWS account:\n"
        f"{json.dumps(compact_summary, indent=2, default=str)}\n\n"
        "Rules:\n"
        "- Answer ONLY based on the data provided above\n"
        "- Be specific — reference actual resource IDs and names\n"
        "- If something is not in the data, say so clearly\n"
        "- Be concise and helpful"
    )

    messages = [{"role": "system", "content": system_prompt}]
    messages = messages + history
    messages.append({"role": "user", "content": message})

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(
                "http://localhost:11434/api/chat",
                json={
                    "model": "minimax-m2.7:cloud",
                    "messages": messages,
                    "stream": False,
                },
            )

            if response.status_code != 200:
                return f"Ollama API error ({response.status_code}): {response.text}"

            data = response.json()

            return data["message"]["content"]

    except httpx.ConnectError:
        return (
            "Cannot connect to Ollama. Make sure Ollama is running "
            "(run: ollama serve) and minimax-m2.7:cloud is installed "
            "(run: ollama pull minimax-m2.7:cloud)"
        )

    except httpx.ReadTimeout:
        return (
            "Ollama timed out (180s). The model is likely still loading "
            "into memory. Wait 30 seconds and try again."
        )

    except Exception as e:
        return f"Ollama error: {type(e).__name__}: {str(e)}"


async def chat_with_anthropic(
    message: str, scan_data: dict, history: list = [], api_key: str = None
) -> str:
    """
    Send a message to the Anthropic Claude API using claude-haiku-4-5.

    Anthropic's API has a DIFFERENT message format to Groq/Ollama:
    the system prompt goes in a dedicated top-level "system" field,
    NOT as a message with role "system" inside the messages array.
    The messages array contains only user/assistant turns.

    Parameters:
        message   (str)  : The user's current question or message.
        scan_data (dict) : The result of a full AWS infrastructure scan.
                           Injected into the system prompt as JSON context.
        history   (list) : Previous conversation turns. Each item must be
                           a dict with 'role' ('user' or 'assistant')
                           and 'content' (str). Defaults to empty list.
        api_key   (str)  : Optional Anthropic API key supplied by the user
                           at runtime. If provided and non-empty, this key
                           is used instead of the ANTHROPIC_API_KEY env var.

    Returns:
        str: The LLM's reply text, or a plain-English error message if
             something goes wrong (never raises an exception to the caller).
    """

    if api_key and api_key.strip():
        resolved_key = api_key.strip()
    else:
        resolved_key = os.getenv("ANTHROPIC_API_KEY")

    if not resolved_key:
        return (
            "No Anthropic API key provided. Please add ANTHROPIC_API_KEY "
            "to .env or enter your key in the chat interface."
        )

    system_prompt = (
        "You are an expert AWS cloud management assistant.\n"
        "You have complete visibility into the user's AWS infrastructure.\n"
        "Here is the CURRENT state of their AWS account:\n"
        f"{json.dumps(scan_data, indent=2, default=str)}\n\n"
        "Rules:\n"
        "- Answer ONLY based on the data provided above\n"
        "- Be specific — reference actual resource IDs and names\n"
        "- If something is not in the data, say so clearly\n"
        "- Be concise and helpful"
    )

    messages = list(history)
    messages.append({"role": "user", "content": message})

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": resolved_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 1024,
                    "system": system_prompt,
                    "messages": messages,
                },
            )

            data = response.json()

            if response.status_code != 200:
                error_message = data.get("error", {}).get("message", str(data))
                return f"Anthropic API error ({response.status_code}): {error_message}"

            return data["content"][0]["text"]

    except Exception as e:
        return f"Error contacting Anthropic: {str(e)}"
