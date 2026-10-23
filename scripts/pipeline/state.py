from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, TypedDict


class Failure(TypedDict, total=False):
    code: str
    check: str
    message: str
    locations: list[str]
    detail: str


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
