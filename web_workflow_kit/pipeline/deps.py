"""节点依赖的外部能力。图只依赖这里的接口，测试时整体替换成假实现。"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Callable

from . import llm
from .agents import Agent, ClaudeCodeCLI, END_TURN, build_agent
from .config import Config, prompt, render
from .design import load_design
from .gate import GateResult, run_gate
from .notify import notify_breaker

VERDICTS = {"fixable", "needs_human"}


def safe_print(line: str) -> None:
    """日志不能因为控制台编码崩掉流水线：cp1252/GBK 控制台打不出的字符替换掉。"""
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        print(line.encode(enc, errors="replace").decode(enc), flush=True)


@dataclass
class Deps:
    cfg: Config
    design: Callable[[str | None], dict | None]
    spec: Callable[[str, dict | None], str]
    coder: Agent
    gate: Callable[[], GateResult]
    reviewer: Callable[[dict[str, Any]], dict[str, Any]]
    fixer: Agent
    notifier: Callable[[dict[str, Any]], str]
    log: Callable[[str], None] = safe_print


def _spec_fn(cfg: Config) -> Callable[[str, dict | None], str]:
    scfg = cfg["spec"]
    system = prompt("spec-prompt.md")

    def run(requirement: str, design: dict | None) -> str:
        user = json.dumps({
            "requirement": requirement,
            "project_type": cfg["verify"].get("type") or "见 rules.yaml",
            "design": design,
        }, ensure_ascii=False, indent=2)
        if scfg.get("backend") == "openai_compatible":
            key = cfg.secret(scfg.get("api_key_env", "OPENAI_API_KEY"))
            if not key:
                raise RuntimeError(f"{scfg.get('api_key_env', 'OPENAI_API_KEY')} is not set")
            return llm.chat(scfg["base_url"], key, scfg["model"], system, user, timeout=int(scfg.get("timeout_sec", 600)))
        # 默认 Claude Code 只读跑一次：-p 模式下未授权的编辑会被拒绝，只会读仓库
        agent = ClaudeCodeCLI(scfg.get("model"), None, 20, int(scfg.get("timeout_sec", 600)))
        r = agent.run(f"{system}\n\n## 输入\n\n```json\n{user}\n```\n\n只输出 Spec 正文，不要修改任何文件。", cfg.project_root)
        if r.stop_reason != END_TURN:
            raise RuntimeError(f"spec agent stop_reason={r.stop_reason}: {r.text[-500:]}")
        return r.text

    return run


def validate_plan(plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict) or plan.get("verdict") not in VERDICTS or not isinstance(plan.get("fixes", []), list):
        raise llm.LLMError(f"review output violates schema: {str(plan)[:300]}")
    plan.setdefault("fixes", [])
    plan.pop("pass", None)  # 顾问无放行权，任何 pass 字段直接丢弃
    return plan


def _reviewer_fn(cfg: Config) -> Callable[[dict[str, Any]], dict[str, Any]]:
    rcfg = cfg["review"]
    system = prompt("review-prompt.md")

    def run(payload: dict[str, Any]) -> dict[str, Any]:
        key = cfg.secret(rcfg.get("api_key_env", "DEEPSEEK_API_KEY"))
        if not key:
            return {"verdict": "unavailable", "summary": f"{rcfg.get('api_key_env')} not set", "fixes": []}
        # 无状态：每次只有 system + 本轮 payload，不带历史
        try:
            text = llm.chat(rcfg["base_url"], key, rcfg["model"], system,
                            json.dumps(payload, ensure_ascii=False), json_mode=True,
                            timeout=int(rcfg.get("timeout_sec", 180)))
            return validate_plan(llm.parse_json(text))
        except (llm.LLMError, json.JSONDecodeError) as e:
            # 顾问不可用不阻塞：修复者直接按失败码干活
            return {"verdict": "unavailable", "summary": str(e)[:300], "fixes": []}

    return run


def default_deps(cfg: Config, log: Callable[[str], None] | None = None) -> Deps:
    return Deps(
        cfg=cfg,
        design=lambda ref: load_design(ref, cfg),
        spec=_spec_fn(cfg),
        coder=build_agent(cfg["code"], cfg, "code-task"),
        # 指定了 log（如本地网页界面）时，门禁逐项输出也走 log；否则直接打到终端
        gate=lambda: run_gate(cfg, log=log),
        reviewer=_reviewer_fn(cfg),
        fixer=build_agent(cfg["fix"], cfg, "fix-task"),
        notifier=lambda state: notify_breaker(state, cfg),
        log=log or safe_print,
    )


def resolve_deps(source: Any, state: dict[str, Any]) -> Deps:
    """图里的节点统一经此取依赖：REPL/测试传固定的 Deps；服务端传按 state 现建的函数。"""
    return source if isinstance(source, Deps) else source(state)


def deps_from_state(state: dict[str, Any]) -> Deps:
    """LangGraph 服务端用：每次运行按输入里的 project_root 加载该项目的配置。

    不缓存——改了项目里的 agent.config.json / .env，下一次运行就生效，不用重启 langgraph dev。
    """
    from .config import load_config

    root = state.get("project_root")
    if not root:
        raise ValueError("input.project_root is required: the absolute path of the front-end project to work on")
    return default_deps(load_config(root))


def code_prompt(requirement: str, spec: str) -> str:
    return render(prompt("code-prompt.md"), requirement=requirement, spec=spec)


def fix_prompt(attempt: int, max_attempts: int, failures: list, plan: dict | None) -> str:
    return render(prompt("fix-prompt.md"), attempt=str(attempt), max_attempts=str(max_attempts),
                  failures=failures, plan=plan or {})
