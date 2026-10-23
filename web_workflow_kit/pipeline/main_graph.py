"""主图（平铺）：codegraph → verify ⇄ codereviewgraph → deliver | breaker

放行只看 verify_exit == 0；熔断由 attempt 计数在代码里强制，与模型输出无关。
"""
from __future__ import annotations

import json
import time
from typing import Any

from langgraph.graph import END, START, StateGraph

from . import names as N
from .checkpoint import entry_of, last_thread, new_thread_id, open_checkpointer, remember
from .codegraph import build_codegraph
from .deps import Deps, resolve_deps
from .diffs import changed_hunks
from .reviewgraph import build_reviewgraph
from .state import FixLoopInput, PipelineInput, PipelineState

CODE_KEYS = ("design", "spec", "baseline", "code_stop_reason", "break_reason")
REVIEW_KEYS = ("plan", "fix_stop_reason", "break_reason")


def _pick(state: dict[str, Any], keys: tuple[str, ...]) -> PipelineState:
    # 子图输出只回传自己负责的字段，避免 history 这类累加字段被重复合并
    return {k: state[k] for k in keys if k in state}  # type: ignore[return-value]


def route_after_verify(state: PipelineState, max_retries: int) -> str:
    exit_code = state.get("verify_exit", 1)
    if exit_code == 0:
        return N.DELIVER
    if exit_code == 2:
        return N.BREAKER            # 规则/环境错误：模型无权也无法修
    if state.get("attempt", 0) > max_retries:
        return N.BREAKER            # 已修复 max_retries 轮仍失败
    return N.REVIEW


# break_reason 前缀 → 给人看的中文说明
BREAK_EXPLAINED = {
    "GATE_CONFIG_ERROR": "门禁规则或运行环境有误（verify 退出码 2），模型无权也无法修复，请检查 rules.yaml 和 Node 环境",
    "RETRY_LIMIT": "已自动修复到上限仍未通过门禁",
    "NEEDS_HUMAN": "验收顾问判断需要人来决定",
    "DESIGN_ERROR": "设计稿读取失败",
    "SPEC_ERROR": "Spec 生成失败",
    "CODE_AGENT_ERROR": "编码 agent 出错",
    "FIX_AGENT_ERROR": "修复 agent 出错",
}

NOTIFY_EXPLAINED = {"sent": "已发熔断邮件", "deduped": "24 小时内已就同类问题发过邮件，本次不重复发送"}


def explain_break(state: PipelineState, notify: str) -> str:
    reason = state.get("break_reason", "")
    key, _, detail = reason.partition(":")
    text = f"已熔断：{BREAK_EXPLAINED.get(key, reason or '原因未知')}"
    if detail.strip() and key in ("NEEDS_HUMAN", "DESIGN_ERROR", "SPEC_ERROR"):
        text += f"（{detail.strip()[:200]}）"
    codes = sorted({f.get("code", "?") for f in state.get("failures", [])})
    if codes:
        text += f"。门禁失败项：{', '.join(codes)}"
    if notify.startswith("skipped(local"):
        text += "。属于本地操作问题，未发邮件"
    elif notify.startswith("skipped"):
        text += "。未发邮件（未配置 SMTP 或发送失败）"
    else:
        text += f"。{NOTIFY_EXPLAINED.get(notify, notify)}"
    return text + "。需要人工介入。"


def build_main_graph(source: Any, entry: str = "code", checkpointer: Any = None):
    """source：固定的 Deps（REPL/测试），或按 state 现建 Deps 的函数（LangGraph 服务端，见 deps_from_state）。

    entry="verify" 跳过 codegraph，直接对当前工作区跑门禁闭环。
    """
    codegraph, reviewgraph = build_codegraph(source), build_reviewgraph(source)

    def code_node(state: PipelineState) -> PipelineState:
        return _pick(codegraph.invoke(state), CODE_KEYS)

    def review_node(state: PipelineState) -> PipelineState:
        return _pick(reviewgraph.invoke(state), REVIEW_KEYS)

    def verify_node(state: PipelineState) -> PipelineState:
        deps = resolve_deps(source, state)
        cfg, log = deps.cfg, deps.log
        log("[门禁] 运行 verify…")
        r = deps.gate()
        attempt = state.get("attempt", 0) + (0 if r.passed else 1)
        codes = sorted({f.get("code", "?") for f in r.failures})
        log(f"[门禁] 退出码 {r.exit_code}" + (f"，失败项 {','.join(codes)}（第 {attempt}/{cfg.max_retries + 1} 次失败）" if codes else "，通过"))
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
        deps = resolve_deps(source, state)
        cfg, log = deps.cfg, deps.log
        # 流水线自己的产物目录（.agent/）不算改动
        own = cfg.state_dir.relative_to(cfg.project_root).as_posix() + "/" if cfg.state_dir.is_relative_to(cfg.project_root) else None
        files = sorted({h["file"] for h in changed_hunks(cfg.project_root, state.get("baseline"), [], 10**9)
                        if not (own and h["file"].startswith(own))})
        record = {
            "requirement": state.get("requirement"),
            "fix_rounds": state.get("attempt", 0),
            "changed_files": files,
            "history": state.get("history", []),
            "delivered_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        (cfg.state_dir / "delivery.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        rounds = state.get("attempt", 0)
        # 有编码前快照（pipeline）时是“本次改动”；fix_loop 没有快照，只能说工作区里有多少未提交改动
        changed = (f"本次改动 {len(files)} 个文件" if state.get("baseline")
                   else f"工作区有 {len(files)} 个未提交的改动文件")
        summary = (f"已交付：门禁通过，{changed}"
                   + (f"，经过 {rounds} 轮自动修复" if rounds else "")
                   + "。代码未提交，等待人工签字发布。")
        log(f"[交付] {summary}")
        return {"status": "delivered", "summary": summary}

    def breaker_node(state: PipelineState) -> PipelineState:
        deps = resolve_deps(source, state)
        reason = state.get("break_reason", "")
        # 设计稿读取失败是人就在 REPL 前的操作问题（如没选中图层），不发邮件
        result = "skipped(local error)" if reason.startswith("DESIGN_ERROR") else deps.notifier(dict(state))
        summary = explain_break(state, result)
        deps.log(f"[熔断] {summary}")
        return {"status": "broken", "summary": summary}

    g = StateGraph(PipelineState, input_schema=PipelineInput if entry == "code" else FixLoopInput)
    first = N.CODE if entry == "code" else N.VERIFY
    if entry == "code":
        g.add_node(N.CODE, code_node)
        g.add_conditional_edges(N.CODE, lambda s: N.BREAKER if s.get("break_reason") else N.VERIFY, [N.VERIFY, N.BREAKER])
    g.add_node(N.VERIFY, verify_node)
    g.add_node(N.REVIEW, review_node)
    g.add_node(N.DELIVER, deliver_node)
    g.add_node(N.BREAKER, breaker_node)

    g.add_edge(START, first)
    g.add_conditional_edges(N.VERIFY, lambda s: route_after_verify(s, resolve_deps(source, s).cfg.max_retries),
                            [N.DELIVER, N.REVIEW, N.BREAKER])
    g.add_conditional_edges(N.REVIEW, lambda s: N.BREAKER if s.get("break_reason") else N.VERIFY, [N.VERIFY, N.BREAKER])
    g.add_edge(N.DELIVER, END)
    g.add_edge(N.BREAKER, END)
    name = N.PIPELINE_NAME if entry == "code" else N.FIX_LOOP_NAME
    return g.compile(checkpointer=checkpointer, name=name)


def recursion_limit(max_retries: int) -> int:
    # 每轮 verify + review 两步；留余量，但真正的上限是 attempt 计数
    return 10 + 3 * (max_retries + 2)


def _run(deps: Deps, entry: str, init: PipelineState | None, thread_id: str) -> PipelineState:
    """init=None 表示从 thread_id 的最后一个检查点继续。"""
    with open_checkpointer(deps.cfg) as saver:
        if init is None and saver is None:
            raise RuntimeError("resume needs langgraph-checkpoint-sqlite (pip install .[checkpoint])")
        graph = build_main_graph(deps, entry, checkpointer=saver)
        config = {"recursion_limit": recursion_limit(deps.cfg.max_retries),
                  "configurable": {"thread_id": thread_id}}
        if saver is not None:
            remember(deps.cfg, thread_id)
            deps.log(f"[运行] 线程 {thread_id}")
        if init is None:
            snapshot = graph.get_state(config)
            if not snapshot.values:
                raise RuntimeError(f"no checkpoint for thread {thread_id}")
            if not snapshot.next:
                deps.log(f"[运行] 线程 {thread_id} 已结束（{snapshot.values.get('status')}）")
                return snapshot.values
        return graph.invoke(init, config)


def run_pipeline(deps: Deps, requirement: str, design_ref: str | None = None) -> PipelineState:
    init: PipelineState = {
        "requirement": requirement,
        "project_root": str(deps.cfg.project_root),
        "design_ref": design_ref,
        "attempt": 0,
        "history": [],
    }
    return _run(deps, "code", init, new_thread_id("code"))


def run_fix_loop(deps: Deps) -> PipelineState:
    """不写新代码，只对当前工作区跑 verify ⇄ review/fix 闭环（人修完后复验也用它）。"""
    init: PipelineState = {
        "requirement": "(修复当前工作区)",
        "project_root": str(deps.cfg.project_root),
        "attempt": 0,
        "history": [],
    }
    return _run(deps, "verify", init, new_thread_id("verify"))


def resume(deps: Deps, thread_id: str | None = None) -> PipelineState:
    """从检查点继续一次被中断的运行；默认取最近一次。"""
    thread_id = thread_id or last_thread(deps.cfg)
    if not thread_id:
        raise RuntimeError("no previous run to resume")
    return _run(deps, entry_of(thread_id), None, thread_id)
