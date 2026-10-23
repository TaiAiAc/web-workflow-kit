"""ACP 后端：经 langgraph-acp 驱动 Claude Code / Codex 等 ACP agent。

和 CLI 后端的差别：stop_reason 直接取自 ACP 的 session/prompt 结果，不用猜；
写文件等动作要走 session/request_permission，由这里的策略应答——门禁文件在这一层就改不了。
需要 `pip install .[acp]`；Claude 适配器经 npx 拉起，需本机已登录 Claude Code 或配置 ANTHROPIC_API_KEY。
"""
from __future__ import annotations

import asyncio
import fnmatch
import os
import shutil
from pathlib import Path, PurePath
from typing import Any, Iterable

from .agents import END_TURN, ERROR, MAX_TOKENS, AgentResult

# 门禁与流水线自身：agent 无权修改
DEFAULT_PROTECTED = ("rules.yaml", "verify/*", "agent.config.json", ".agent/*", ".github/*", ".env", ".env.*")
DEFAULT_ALLOW_KINDS = ("read", "search", "think", "edit")
WRITE_KINDS = {"edit", "delete", "move"}

STOP_REASONS = {
    "end_turn": END_TURN,
    "max_tokens": MAX_TOKENS,
    "max_turn_requests": MAX_TOKENS,
}


def map_stop_reason(reason: str | None) -> str:
    # refusal / cancelled / 缺失 一律按 error 处理，交给熔断
    return STOP_REASONS.get(reason or "", ERROR)


def _relative(path: str, root: Path) -> str | None:
    """返回相对项目根的 posix 路径；在项目外返回 None。"""
    p = Path(path)
    if not p.is_absolute():
        p = root / p
    try:
        return PurePath(os.path.relpath(p.resolve(), root.resolve())).as_posix()
    except ValueError:  # Windows 上跨盘符
        return None


def is_allowed(tool_call: dict[str, Any], root: Path, allow_kinds: Iterable[str],
               protected: Iterable[str]) -> tuple[bool, str]:
    kind = tool_call.get("kind") or "other"
    if kind not in set(allow_kinds):
        return False, f"kind {kind!r} not allowed"
    if kind in WRITE_KINDS:
        locations = [loc.get("path") for loc in tool_call.get("locations") or [] if isinstance(loc, dict)]
        if not locations:
            return False, "write without a target path"
        for raw in locations:
            rel = _relative(str(raw), root) if raw else None
            if rel is None or rel.startswith("../") or rel == "..":
                return False, f"write outside project: {raw}"
            if any(fnmatch.fnmatch(rel, pat) for pat in protected):
                return False, f"protected path: {rel}"
    return True, "ok"


def make_permission_policy(root: Path, allow_kinds: Iterable[str], protected: Iterable[str], denied: list[str]):
    from langgraph_acp import ACPPermissionOutcome

    allow_kinds, protected = tuple(allow_kinds), tuple(protected)

    async def handle(request):
        ok, why = is_allowed(dict(request.tool_call), root, allow_kinds, protected)
        if ok:
            for option in request.options:
                if option.kind == "allow_once":
                    return ACPPermissionOutcome.selected(option.option_id)
            why = "no allow_once option offered"
        denied.append(f"{request.tool_call.get('title') or request.tool_call.get('kind')}: {why}")
        return ACPPermissionOutcome.cancelled()

    return handle


def local_adapter(command: Iterable[str] | None) -> list[str] | None:
    """内置适配器默认经 `npx --yes <包>@<版本>` 拉起，每次运行都要访问 npm 仓库，网络一抖就失败。
    本机已全局安装同名命令（如 `npm i -g @agentclientprotocol/codex-acp`）时直接用它。"""
    if not command:
        return None
    command = list(command)
    if command[0] != "npx":
        return command
    spec = command[-1]
    package = spec[:spec.rfind("@")] if spec.rfind("@") > 0 else spec   # 去掉版本，保留 @scope
    found = shutil.which(package.rsplit("/", 1)[-1])
    return [found] if found else command


class ACPAgent:
    def __init__(self, agent: str = "claude", command: list[str] | None = None,
                 allow_kinds: Iterable[str] = DEFAULT_ALLOW_KINDS,
                 protected: Iterable[str] = DEFAULT_PROTECTED, timeout_sec: int = 1800,
                 env: dict[str, str] | None = None):
        self.agent, self.command, self.timeout, self.env = agent, command, timeout_sec, env
        self.allow_kinds, self.protected = tuple(allow_kinds), tuple(protected)

    def _provider(self, cwd: Path, denied: list[str]):
        import langgraph_acp as acp

        defaults = {"claude": acp.CLAUDE_ACP_COMMAND, "codex": acp.CODEX_ACP_COMMAND}
        command = list(self.command or local_adapter(defaults.get(self.agent)) or [])
        if not command:
            raise ValueError(f"no ACP command for agent {self.agent!r}; set code.command")
        # asyncio 子进程不按 PATHEXT 解析，Windows 上 npx 必须先解析成 npx.cmd / npx.exe
        command[0] = shutil.which(command[0]) or command[0]
        return acp.StdioACPProvider(
            name=self.agent, command=command, env=dict(self.env or os.environ), cwd=str(cwd),
            permissions=make_permission_policy(cwd, self.allow_kinds, self.protected, denied),
        )

    async def _run(self, prompt: str, cwd: Path, denied: list[str]):
        from langgraph_acp import ACPAgentRegistry, ACPNode

        registry = ACPAgentRegistry([self._provider(cwd, denied)])
        return await ACPNode(agent=self.agent, registry=registry, working_directory=str(cwd))(prompt)

    def run(self, prompt: str, cwd: Path) -> AgentResult:
        denied: list[str] = []
        try:
            result = asyncio.run(asyncio.wait_for(self._run(prompt, cwd, denied), self.timeout))
        except asyncio.TimeoutError:
            return AgentResult(ERROR, f"ACP {self.agent} timed out after {self.timeout}s")
        except Exception as e:  # 连接失败、握手失败、协议错误
            return AgentResult(ERROR, f"ACP {self.agent}: {type(e).__name__}: {e}")
        text = result.message
        if denied:
            text += "\n\n[denied permission requests]\n" + "\n".join(f"- {d}" for d in denied)
        return AgentResult(map_stop_reason(result.stop_reason), text)
