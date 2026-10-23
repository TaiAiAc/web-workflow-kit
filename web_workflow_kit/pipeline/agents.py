"""写代码 / 修复的 agent 适配层。

所有后端都归一成 ACP 的 stop_reason 语义：end_turn / max_tokens / error。
第一版走 CLI（Claude Code `-p`、DeepSeek Harness `headless`）；ACP 后端（langgraph-acp）留在 Day 4。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .config import Config

END_TURN, MAX_TOKENS, ERROR = "end_turn", "max_tokens", "error"


@dataclass
class AgentResult:
    stop_reason: str
    text: str = ""


class Agent(Protocol):
    def run(self, prompt: str, cwd: Path) -> AgentResult: ...


def _resolve(cmd: str) -> str | None:
    # Windows 上 dsh / claude 是 .cmd，需要按 PATHEXT 解析
    return shutil.which(cmd)


class ClaudeCodeCLI:
    """`claude -p --output-format json`，prompt 走 stdin，避开命令行长度和转义问题。"""

    def __init__(self, model: str | None = None, permission_mode: str | None = None,
                 max_turns: int | None = None, timeout_sec: int = 1800):
        self.model, self.permission_mode, self.max_turns, self.timeout = model, permission_mode, max_turns, timeout_sec

    def run(self, prompt: str, cwd: Path) -> AgentResult:
        exe = _resolve("claude")
        if not exe:
            return AgentResult(ERROR, "claude CLI not found on PATH")
        cmd = [exe, "-p", "--output-format", "json"]
        if self.model:
            cmd += ["--model", self.model]
        if self.permission_mode:
            cmd += ["--permission-mode", self.permission_mode]
        if self.max_turns:
            cmd += ["--max-turns", str(self.max_turns)]
        try:
            r = subprocess.run(cmd, input=prompt, cwd=cwd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=self.timeout)
        except subprocess.TimeoutExpired:
            return AgentResult(ERROR, f"claude timed out after {self.timeout}s")
        try:
            data = json.loads(r.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            return AgentResult(ERROR, (r.stderr or r.stdout)[-2000:])
        subtype = data.get("subtype", "")
        if data.get("is_error") or r.returncode != 0:
            reason = MAX_TOKENS if subtype == "error_max_turns" else ERROR
        else:
            reason = END_TURN
        return AgentResult(reason, str(data.get("result", "")))


class CommandAgent:
    """通用命令行 agent（默认 DeepSeek Harness：`dsh headless "<prompt>"`）。

    长 prompt 写进文件，命令行只传一句英文指令，避免 cmd.exe 的长度/编码问题。
    """

    def __init__(self, command: list[str], task_file: Path, timeout_sec: int = 1800):
        self.command, self.task_file, self.timeout = command, task_file, timeout_sec

    def run(self, prompt: str, cwd: Path) -> AgentResult:
        exe = _resolve(self.command[0])
        if not exe:
            return AgentResult(ERROR, f"{self.command[0]} not found on PATH")
        self.task_file.parent.mkdir(parents=True, exist_ok=True)
        self.task_file.write_text(prompt, encoding="utf-8")
        rel = self.task_file.relative_to(cwd) if self.task_file.is_relative_to(cwd) else self.task_file
        # 同一个 agent 既可能写代码也可能修复：指令保持通用，具体任务在文件里
        short = f"Read {rel.as_posix()} and carry out the task it describes, then stop."
        cmd = [exe, *(a.replace("{prompt}", short) for a in self.command[1:])]
        try:
            r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=self.timeout)
        except subprocess.TimeoutExpired:
            return AgentResult(ERROR, f"{self.command[0]} timed out after {self.timeout}s")
        return AgentResult(END_TURN if r.returncode == 0 else ERROR, (r.stdout + r.stderr)[-4000:])


def coding_agent_choices(cfg: Config) -> dict[str, dict]:
    """可选的编程 agent：{key: 预设}。项目的 agent.config.json 可以改预设或加新的。"""
    return cfg.raw.get("coding_agents", {})


def agent_availability(preset: dict) -> tuple[bool, str]:
    """只查命令在不在 PATH 上；登录状态要真正调用时才知道。"""
    exe = preset.get("requires") or (preset.get("command") or [None])[0]
    if not exe:
        return True, ""
    found = _resolve(exe)
    return (True, found) if found else (False, f"未找到 {exe} 命令")


def build_coding_agent(cfg: Config, choice: str | None = None) -> Agent:
    """按选择构建“写代码”的 agent：预设（coding_agents.<key>）+ code 段的公共项（如超时）。"""
    key = choice or cfg["code"].get("agent", "claude")
    presets = coding_agent_choices(cfg)
    if key not in presets:
        raise ValueError(f"未知的编程 agent：{key}（可选：{', '.join(presets)}）")
    common = {k: v for k, v in cfg["code"].items() if k != "agent"}
    return build_agent({**common, **presets[key]}, cfg, "code-task")


def build_agent(section: dict, cfg: Config, task_name: str) -> Agent:
    backend = section.get("backend", "claude_cli")
    if backend == "claude_cli":
        return ClaudeCodeCLI(section.get("model"), section.get("permission_mode"),
                             section.get("max_turns"), int(section.get("timeout_sec", 1800)))
    if backend in ("dsh_cli", "command"):
        return CommandAgent(section["command"], cfg.state_dir / f"{task_name}.md", int(section.get("timeout_sec", 1800)))
    if backend == "acp":
        from .acp_agent import DEFAULT_ALLOW_KINDS, DEFAULT_PROTECTED, ACPAgent
        return ACPAgent(section.get("agent", "claude"), section.get("command"),
                        section.get("allow_kinds", DEFAULT_ALLOW_KINDS),
                        section.get("protected", DEFAULT_PROTECTED), int(section.get("timeout_sec", 1800)))
    raise ValueError(f"unknown agent backend: {backend}")
