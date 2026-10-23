"""codereviewgraph：验收顾问（DeepSeek）出修复计划 → DeepSeek Harness 改文件。可单独运行。

进入前提：state 里已有本轮门禁的 failures。本图不跑门禁，也不做放行判断。
"""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from .agents import ERROR
from .deps import resolve_deps, fix_prompt
from . import names as N
from .diffs import changed_hunks
from .state import PipelineState, ReviewInput


def build_reviewgraph(source):
    """source：固定的 Deps，或按 state 现建 Deps 的函数（服务端）。"""

    def review_node(state: PipelineState) -> PipelineState:
        deps = resolve_deps(source, state)
        cfg, log = deps.cfg, deps.log
        failures = state.get("failures", [])
        dcfg = cfg["diff"]
        payload = {
            "project_type": cfg["verify"].get("type") or "见 rules.yaml",
            "attempt": state.get("attempt", 1),
            "max_attempts": cfg.max_retries,
            "requirement": state.get("requirement", ""),
            "spec_excerpt": (state.get("spec") or "")[:2000],
            "failures": failures,
            "diff_hunks": changed_hunks(cfg.project_root, state.get("baseline"), failures,
                                        int(dcfg.get("max_chars", 12000)), int(dcfg.get("context_lines", 3))),
        }
        log(f"[验收审阅] {len(failures)} 个失败项、{len(payload['diff_hunks'])} 个改动块 → 验收顾问")
        plan = deps.reviewer(payload)
        log(f"[验收审阅] 结论 {plan.get('verdict')}（经 {plan.get('reviewer', '?')}）：{plan.get('summary', '')}")
        out: PipelineState = {"plan": plan}
        if plan.get("verdict") == "needs_human":
            out["break_reason"] = f"NEEDS_HUMAN: {plan.get('summary', '')}"
        return out

    def fix_node(state: PipelineState) -> PipelineState:
        deps = resolve_deps(source, state)
        cfg, log = deps.cfg, deps.log
        log("[执行修复] 修复 agent 工作中…")
        r = deps.fixer.run(
            fix_prompt(state.get("attempt", 1), cfg.max_retries, state.get("failures", []), state.get("plan")),
            cfg.project_root,
        )
        log(f"[执行修复] 结束，stop_reason={r.stop_reason}")
        out: PipelineState = {"fix_stop_reason": r.stop_reason}
        if r.stop_reason == ERROR:
            out["break_reason"] = f"FIX_AGENT_ERROR: {r.text[-500:]}"
        return out

    g = StateGraph(PipelineState, input_schema=ReviewInput)
    g.add_node(N.ADVISE, review_node)
    g.add_node(N.FIX, fix_node)
    g.add_edge(START, N.ADVISE)
    g.add_conditional_edges(N.ADVISE, lambda s: END if s.get("break_reason") else N.FIX, [N.FIX, END])
    g.add_edge(N.FIX, END)
    return g.compile(name=N.REVIEWGRAPH_NAME)
