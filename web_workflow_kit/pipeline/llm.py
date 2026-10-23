"""OpenAI 兼容的 Chat Completions 客户端（DeepSeek / GPT），只用标准库。"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any


class LLMError(RuntimeError):
    pass


def chat(base_url: str, api_key: str, model: str, system: str, user: str,
         json_mode: bool = False, timeout: int = 180) -> str:
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise LLMError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:500]}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise LLMError(str(e)) from e
    choice = data["choices"][0]
    if choice.get("finish_reason") == "length":
        raise LLMError("response truncated (finish_reason=length)")
    return choice["message"]["content"]


def parse_json(text: str) -> dict[str, Any]:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise LLMError("no JSON object in response")
    return json.loads(text[start: end + 1])
