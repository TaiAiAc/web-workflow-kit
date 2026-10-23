"""设计稿读取。

第一版支持本地导出的 JSON 文件；MasterGo MCP（@mastergo/vibe-mcp）经 langchain-mcp-adapters 接入，
属于 Day 4 可选项，需要 `pip install .[mcp]` 并在 agent.config.json 的 design.tool 填工具名。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from .config import Config


def _clip(data: Any, max_chars: int) -> dict[str, Any]:
    text = json.dumps(data, ensure_ascii=False)
    if len(text) <= max_chars:
        return data if isinstance(data, dict) else {"data": data}
    return {"truncated": True, "raw": text[:max_chars]}


async def _via_mcp(ref: str, cfg: Config) -> Any:
    from langchain_mcp_adapters.client import MultiServerMCPClient  # 可选依赖

    dcfg = cfg["design"]
    if not dcfg.get("tool"):
        raise RuntimeError("design.tool is not set in agent.config.json (name of the MasterGo MCP tool to call)")
    mcp = dcfg["mcp"]
    env = {k: cfg.secret(k) or "" for k in mcp.get("env_keys", [])}
    client = MultiServerMCPClient({
        "mastergo": {"command": mcp["command"], "args": mcp["args"], "env": env, "transport": "stdio"},
    })
    tools = {t.name: t for t in await client.get_tools()}
    if dcfg["tool"] not in tools:
        raise RuntimeError(f"MCP tool {dcfg['tool']!r} not found; available: {sorted(tools)}")
    result = await tools[dcfg["tool"]].ainvoke({"url": ref})
    return json.loads(result) if isinstance(result, str) and result.lstrip().startswith(("{", "[")) else result


def load_design(ref: str | None, cfg: Config) -> dict[str, Any] | None:
    if not ref:
        return None
    max_chars = int(cfg["design"].get("max_chars", 20000))
    path = (cfg.project_root / ref) if not Path(ref).is_absolute() else Path(ref)
    if path.suffix == ".json" and path.is_file():
        return _clip(json.loads(path.read_text(encoding="utf-8")), max_chars)
    if not cfg["design"].get("enabled"):
        raise RuntimeError(f"design ref {ref!r} is not a local .json file and design.enabled is false")
    return _clip(asyncio.run(_via_mcp(ref, cfg)), max_chars)
