from __future__ import annotations

import operator
from typing import Annotated, Any, Literal

from typing_extensions import Required, TypedDict  # Python 3.10 没有 typing.Required


class Failure(TypedDict, total=False):
    code: str
    check: str
    message: str
    locations: list[str]
    detail: str


class FixLoopInput(TypedDict):
    """fix_loop 的输入：不写新代码，只对现有工作区跑门禁 ⇄ 修复。"""
    project_root: str                 # 目标前端项目的绝对路径


class PipelineInput(FixLoopInput, total=False):
    """主流水线的输入，也是 LangGraph Studio 里的输入表单。"""
    requirement: Required[str]        # 需求原文
    design_ref: str | None            # 可选：本地设计稿 .json，或 "mastergo"（读本机 MasterGo 当前选中图层）


class PipelineState(TypedDict, total=False):
    # 输入
    requirement: str
    project_root: str
    design_ref: str | None
    # codegraph
    design: dict[str, Any] | None
    spec: str
    baseline: dict[str, Any]          # 编码前的工作区快照，用于只取本次改动块
    code_stop_reason: str
    # 门禁
    attempt: int                      # 已失败的门禁轮数，代码强制熔断依据
    verify_exit: int                  # verify.ts 退出码：唯一放行依据
    failures: list[Failure]           # 只保留失败项
    # codereviewgraph
    plan: dict[str, Any] | None
    fix_stop_reason: str
    # 结果
    status: Literal["delivered", "broken"]
    break_reason: str
    history: Annotated[list[dict[str, Any]], operator.add]
