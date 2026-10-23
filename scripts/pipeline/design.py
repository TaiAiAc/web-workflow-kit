"""设计稿读取。

两种来源：
- 本地导出的 `.json` 文件路径；
- `mastergo` / `mastergo:selection`：经 @mastergo/vibe-mcp 读取本机 MasterGo 客户端里**当前选中的图层**和文件变量。
  vibe-mcp 连的是本地 MasterGo 服务（默认 http://localhost:30678），不按链接取稿，所以先在 MasterGo 里选中图层再跑。
  需要 `pip install .[mcp]`，并在 agent.config.json 打开 design.enabled。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any

from .config import Config

MASTERGO_REFS = {"mastergo", "mastergo:selection", "selection"}


def _clip(data: Any, max_chars: int) -> dict[str, Any]:
    text = json.dumps(data, ensure_ascii=False, default=str)
    if len(text) <= max_chars:
        return data if isinstance(data, dict) else {"data": data}
    return {"truncated": True, "raw": text[:max_chars]}


def _required_args(tool: Any) -> list[str]:
    schema = getattr(tool, "args_schema", None)
    if schema is None:
        return []
    if not isinstance(schema, dict):
        schema = schema.model_json_schema()
    return list(schema.get("required", []))


FULL_DATA_MARK = "完整数据："


def _decode(name: str, result: Any) -> Any:
    """MCP 工具返回字符串或内容块列表。vibe-mcp 的格式是“✅ 摘要 … 完整数据：{json}”，失败时以 ❌ 开头。"""
    if isinstance(result, tuple):  # content_and_artifact 形式
        result = result[0]
    if isinstance(result, list):
        texts = [b.get("text", "") if isinstance(b, dict) else str(b) for b in result]
        result = "\n".join(t for t in texts if t)
    if not isinstance(result, str):
        return result
    text = result.strip()
    if text.startswith("❌"):
        # 例如没选中图层：必须拦下，否则错误文案会被当成设计稿喂给 Spec
        raise RuntimeError(f"MasterGo {name}: {text}")
    if FULL_DATA_MARK in text:
        text = text.split(FULL_DATA_MARK, 1)[1].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


async def _via_mcp(cfg: Config) -> dict[str, Any]:
    from langchain_mcp_adapters.client import MultiServerMCPClient  # 可选依赖

    dcfg, mcp = cfg["design"], cfg["design"]["mcp"]
    command = shutil.which(mcp["command"]) or mcp["command"]  # Windows 上 npx 是 npx.cmd
    args = [*mcp["args"], f"--url={mcp['url']}"] if mcp.get("url") else list(mcp["args"])
    # 不传 env 时 MCP SDK 只给子进程一小撮白名单变量，npx 的代理和 shim 配置会丢，表现为卡死
    env = {**os.environ, **{k: v for k in mcp.get("env_keys", []) if (v := cfg.secret(k))}}
    client = MultiServerMCPClient({
        "mastergo": {"command": command, "args": args, "env": env, "transport": "stdio"},
    })
    timeout = float(dcfg.get("timeout_sec", 120))
    tools = {t.name: t for t in await asyncio.wait_for(client.get_tools(), timeout)}

    # vibe-mcp 的读取类工具都要 projectDir（素材落盘的目标项目）
    args = {"projectDir": str(cfg.project_root)}
    out: dict[str, Any] = {}
    for name in dcfg.get("tools", ["get_selection_node", "get_variables"]):
        tool = tools.get(name)
        if tool is None:
            raise RuntimeError(f"MasterGo MCP tool {name!r} not found; available: {sorted(tools)}")
        missing = [a for a in _required_args(tool) if a not in args]
        if missing:
            raise RuntimeError(f"MasterGo MCP tool {name!r} needs arguments {missing}; only read-only tools are supported")
        out[name] = _decode(name, await asyncio.wait_for(tool.ainvoke(args), timeout))
    return out


def _clip_each(data: dict[str, Any], max_chars: int) -> dict[str, Any]:
    # 按工具分别预算：变量表很长时不能把选中图层也一起截没
    share = max(1000, max_chars // max(1, len(data)))
    return {k: _clip(v, share) for k, v in data.items()}


def load_design(ref: str | None, cfg: Config) -> dict[str, Any] | None:
    if not ref:
        return None
    max_chars = int(cfg["design"].get("max_chars", 20000))
    if ref.strip().lower() in MASTERGO_REFS:
        if not cfg["design"].get("enabled"):
            raise RuntimeError("MasterGo design reading is off; set design.enabled=true in agent.config.json")
        return _clip_each(asyncio.run(_via_mcp(cfg)), max_chars)
    path = Path(ref) if Path(ref).is_absolute() else cfg.project_root / ref
    if path.suffix == ".json" and path.is_file():
        return _clip(json.loads(path.read_text(encoding="utf-8")), max_chars)
    raise RuntimeError(f"design ref {ref!r} is neither a local .json file nor 'mastergo'")
