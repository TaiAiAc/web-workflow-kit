"""主图（平铺）：codegraph → verify ⇄ codereviewgraph → deliver | breaker

放行只看 verify_exit == 0；熔断由 attempt 计数在代码里强制，与模型输出无关。
"""
from __future__ import annotations

import json
import time
from typing import Any

from langgraph.graph import END, START, StateGraph

from .codegraph import build_codegraph
from .deps import Deps
from .diffs import changed_hunks
from .reviewgraph import build_reviewgraph
from .state import PipelineState

CODE_KEYS = ("design", "spec", "baseline", "code_stop_reason", "break_reason")
REVIEW_KEYS = ("plan", "fix_stop_reason", "break_reason")


def _pick(state: dict[str, Any], keys: tuple[str, ...]) -> PipelineState:
    # 子图输出只回传自己负责的字段，避免 history 这类累加字段被重复合并
    return {k: state[k] for k in keys if k in state}  # type: ignore[return-value]


def route_after_verify(state: PipelineState, max_retries: int) -> str:
    exit_code = state.get("verify_exit", 1)
    if exit_code == 0:
        return "deliver"
    if exit_code == 2:
        return "breaker"            # 规则/环境错误：模型无权也无法修
    if state.get("attempt", 0) > max_retries:
        return "breaker"            # 已修复 max_retries 轮仍失败
    return "review"


def build_main_graph(deps: Deps, entry: str = "code"):
    """entry="verify" 跳过 codegraph，直接对当前工作区跑门禁闭环。"""
    cfg, log = deps.cfg, deps.log
    codegraph, reviewgraph = build_codegraph(deps), build_reviewgraph(deps)

    def code_node(state: PipelineState) -> PipelineState:
        return _pick(codegraph.invoke(state), CODE_KEYS)

    def review_node(state: PipelineState) -> PipelineState:
        return _pick(reviewgraph.invoke(state), REVIEW_KEYS)

    def verify_node(state: PipelineState) -> PipelineState:
        log("[verify] running verify.ts…")
        r = deps.gate()
        attempt = state.get("attempt", 0) + (0 if r.passed else 1)
        codes = sorted({f.get("code", "?") for f in r.failures})
        log(f"[verify] exit={r.exit_code}" + (f" codes={','.join(codes)} (fail {attempt}/{cfg.max_retries + 1})" if codes else ""))
        out: PipelineState = {
            "verify_exit": r.exit_code,
            "failures": r.failures,
            "attempt": attempt,
            "plan": None,
            "history": [{"attempt": attempt, "exit": r.exit_code, "codes": codes}],
        }
        if r.exit_code == 2:
            out["break_reason"] = "GATE_CONFIG_ERROR"
        elif not r.passed and attempt > cfg.max_retries:
            out["break_reason"] = f"RETRY_LIMIT: {cfg.max_retries} fix round(s) exhausted"
        return out

    def deliver_node(state: PipelineState) -> PipelineState:
        files = sorted({h["file"] for h in changed_hunks(cfg.project_root, state.get("baseline"), [], 10**9)})
        record = {
            "requirement": state.get("requirement"),
            "fix_rounds": state.get("attempt", 0),
            "changed_files": files,
            "history": state.get("history", []),
            "delivered_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        (cfg.state_dir / "delivery.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"[deliver] gate passed; {len(files)} file(s) changed. 未提交，等待人工签字发布。")
        return {"status": "delivered"}

    def breaker_node(state: PipelineState) -> PipelineState:
        result = deps.notifier(dict(state))
        log(f"[breaker] {state.get('break_reason', 'unknown')} — notify: {result}")
        return {"status": "broken"}

    g = StateGraph(PipelineState)
    if entry == "code":
        g.add_node("code", code_node)
        g.add_conditional_edges("code", lambda s: "breaker" if s.get("break_reason") else "verify", ["verify", "breaker"])
    g.add_node("verify", verify_node)
    g.add_node("review", review_node)
    g.add_node("deliver", deliver_node)
    g.add_node("breaker", breaker_node)

    g.add_edge(START, entry)
    g.add_conditional_edges("verify", lambda s: route_after_verify(s, cfg.max_retries), ["deliver", "review", "breaker"])
    g.add_conditional_edges("review", lambda s: "breaker" if s.get("break_reason") else "verify", ["verify", "breaker"])
    g.add_edge("deliver", END)
    g.add_edge("breaker", END)
    return g.compile()


def recursion_limit(max_retries: int) -> int:
    # 每轮 verify + review 两步；留余量，但真正的上限是 attempt 计数
    return 10 + 3 * (max_retries + 2)


def run_pipeline(deps: Deps, requirement: str, design_ref: str | None = None) -> PipelineState:
    graph = build_main_graph(deps)
    init: PipelineState = {
        "requirement": requirement,
        "project_root": str(deps.cfg.project_root),
        "design_ref": design_ref,
        "attempt": 0,
        "history": [],
    }
    return graph.invoke(init, {"recursion_limit": recursion_limit(deps.cfg.max_retries)})


def run_fix_loop(deps: Deps) -> PipelineState:
    """不写新代码，只对当前工作区跑 verify ⇄ review/fix 闭环（人修完后复验也用它）。"""
    graph = build_main_graph(deps, entry="verify")
    init: PipelineState = {
        "requirement": "(修复当前工作区)",
        "project_root": str(deps.cfg.project_root),
        "attempt": 0,
        "history": [],
    }
    return graph.invoke(init, {"recursion_limit": recursion_limit(deps.cfg.max_retries)})
