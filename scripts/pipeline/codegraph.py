"""codegraph：设计稿 → Spec → 写代码。可单独运行。"""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from .agents import END_TURN, ERROR
from .deps import Deps, code_prompt
from .diffs import snapshot
from .state import PipelineState


def build_codegraph(deps: Deps):
    cfg, log = deps.cfg, deps.log

    def design_node(state: PipelineState) -> PipelineState:
        ref = state.get("design_ref")
        if not ref:
            return {"design": None}
        try:
            design = deps.design(ref)
            log(f"[design] loaded {ref}")
            return {"design": design}
        except Exception as e:  # 明确指定了设计稿却读不到：停下，别让 Spec 凭空编
            log(f"[design] failed: {e}")
            return {"design": None, "break_reason": f"DESIGN_ERROR: {e}"}

    def spec_node(state: PipelineState) -> PipelineState:
        log("[spec] generating…")
        try:
            spec = deps.spec(state["requirement"], state.get("design"))
        except Exception as e:
            return {"break_reason": f"SPEC_ERROR: {e}"}
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        (cfg.state_dir / "spec.md").write_text(spec, encoding="utf-8")
        log(f"[spec] written to {cfg.state_dir / 'spec.md'}")
        return {"spec": spec}

    def code_node(state: PipelineState) -> PipelineState:
        baseline = snapshot(cfg.project_root)
        log("[code] Claude Code is writing…")
        r = deps.coder.run(code_prompt(state["requirement"], state["spec"]), cfg.project_root)
        log(f"[code] stop_reason={r.stop_reason}")
        out: PipelineState = {"baseline": baseline, "code_stop_reason": r.stop_reason}
        if r.stop_reason == ERROR:
            out["break_reason"] = f"CODE_AGENT_ERROR: {r.text[-500:]}"
        elif r.stop_reason != END_TURN:
            log("[code] agent stopped early; gate will decide")
        return out

    g = StateGraph(PipelineState)
    g.add_node("design", design_node)
    g.add_node("spec", spec_node)
    g.add_node("code", code_node)
    g.add_edge(START, "design")
    g.add_conditional_edges("design", lambda s: END if s.get("break_reason") else "spec", ["spec", END])
    g.add_conditional_edges("spec", lambda s: END if s.get("break_reason") else "code", ["code", END])
    g.add_edge("code", END)
    return g.compile()
