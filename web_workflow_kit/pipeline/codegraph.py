"""codegraph：设计稿 → Spec → 写代码。可单独运行。"""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from .agents import END_TURN, ERROR
from .deps import resolve_deps, code_prompt
from . import names as N
from .diffs import snapshot
from .state import PipelineInput, PipelineState


def build_codegraph(source):
    """source：固定的 Deps，或按 state 现建 Deps 的函数（服务端）。"""

    def design_node(state: PipelineState) -> PipelineState:
        deps = resolve_deps(source, state)
        cfg, log = deps.cfg, deps.log
        ref = state.get("design_ref")
        if not ref:
            return {"design": None}
        try:
            design = deps.design(ref)
            log(f"[读取设计稿] 已读取 {ref}")
            return {"design": design}
        except Exception as e:  # 明确指定了设计稿却读不到：停下，别让 Spec 凭空编
            log(f"[读取设计稿] 失败：{e}")
            return {"design": None, "break_reason": f"DESIGN_ERROR: {e}"}

    def spec_node(state: PipelineState) -> PipelineState:
        deps = resolve_deps(source, state)
        cfg, log = deps.cfg, deps.log
        log("[生成Spec] 生成中…")
        try:
            spec = deps.spec(state["requirement"], state.get("design"))
        except Exception as e:
            return {"break_reason": f"SPEC_ERROR: {e}"}
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        (cfg.state_dir / "spec.md").write_text(spec, encoding="utf-8")
        log(f"[生成Spec] 已写入 {cfg.state_dir / 'spec.md'}")
        return {"spec": spec}

    def code_node(state: PipelineState) -> PipelineState:
        deps = resolve_deps(source, state)
        cfg, log = deps.cfg, deps.log
        baseline = snapshot(cfg.project_root)
        log("[写代码] 编码 agent 工作中…")
        r = deps.coder.run(code_prompt(state["requirement"], state["spec"]), cfg.project_root)
        log(f"[写代码] 结束，stop_reason={r.stop_reason}")
        out: PipelineState = {"baseline": baseline, "code_stop_reason": r.stop_reason}
        if r.stop_reason == ERROR:
            out["break_reason"] = f"CODE_AGENT_ERROR: {r.text[-500:]}"
        elif r.stop_reason != END_TURN:
            log("[写代码] agent 提前停止，交给门禁判定")
        return out

    g = StateGraph(PipelineState, input_schema=PipelineInput)
    g.add_node(N.DESIGN, design_node)
    g.add_node(N.SPEC, spec_node)
    g.add_node(N.WRITE_CODE, code_node)
    g.add_edge(START, N.DESIGN)
    g.add_conditional_edges(N.DESIGN, lambda s: END if s.get("break_reason") else N.SPEC, [N.SPEC, END])
    g.add_conditional_edges(N.SPEC, lambda s: END if s.get("break_reason") else N.WRITE_CODE, [N.WRITE_CODE, END])
    g.add_edge(N.WRITE_CODE, END)
    return g.compile(name=N.CODEGRAPH_NAME)
