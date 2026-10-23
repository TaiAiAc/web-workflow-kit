from __future__ import annotations

import operator
from typing import Annotated, Any, Literal

from pydantic import ConfigDict, Field
from typing_extensions import Required, TypedDict  # Python 3.10 没有 typing.Required

# 输入字段的 title / description 会进 JSON Schema，LangGraph Studio 用它渲染中文输入表单。
# 字段名（project_root 等）保持英文：它们是 API 契约，调用方和检查点都按它取值。
ProjectRoot = Annotated[str, Field(
    title="项目路径",
    description="目标前端项目的绝对路径，如 D:/projects/my-app；流水线按该项目的 agent.config.json、.env、rules.yaml 运行",
)]
Requirement = Annotated[str, Field(title="需求", description="需求原文，一句话或一段话")]
AgentKey = Literal["claude", "codex", "opencode", "workbuddy", "dsh"]
CodingAgent = Annotated[AgentKey | None, Field(
    title="编程 agent",
    description="写代码这一步用哪个 agent：Claude Code / Codex / OpenCode / WorkBuddy / DeepSeek Harness；不选则用配置里的 code.agent",
)]
FixAgent = Annotated[AgentKey | None, Field(
    title="修复 agent",
    description="门禁失败后按修复计划改代码用哪个 agent，可选项同编程 agent；不选则用配置里的 fix（默认 DeepSeek Harness）",
)]
ReviewBackend = Annotated[Literal["auto", "api", "dsh", "skip"] | None, Field(
    title="验收审阅",
    description="门禁失败后谁出修复计划：自动（有 DeepSeek Key 用 API，否则用 dsh）/ DeepSeek API / DeepSeek Harness / 跳过",
)]
DesignRef = Annotated[str | None, Field(
    title="设计稿（可选）",
    description="本地导出的设计稿 .json 路径；或填 mastergo，读取本机 MasterGo 当前选中的图层和文件变量",
)]


class Failure(TypedDict, total=False):
    code: str
    check: str
    message: str
    locations: list[str]
    detail: str


class FixLoopInput(TypedDict, total=False):
    """fix_loop 的输入：不写新代码，只对现有工作区跑门禁 ⇄ 修复。"""
    __pydantic_config__ = ConfigDict(title="门禁修复回环 · 输入")  # type: ignore[misc]
    project_root: Required[ProjectRoot]
    review_backend: ReviewBackend
    fix_agent: FixAgent


class PipelineInput(TypedDict, total=False):
    """主流水线的输入，也是 LangGraph Studio 里的输入表单。"""
    __pydantic_config__ = ConfigDict(title="前端交付流水线 · 输入")  # type: ignore[misc]
    project_root: Required[ProjectRoot]
    requirement: Required[Requirement]
    coding_agent: CodingAgent
    review_backend: ReviewBackend
    fix_agent: FixAgent
    design_ref: DesignRef


class ReviewInput(TypedDict, total=False):
    """reviewgraph 的输入：上一轮门禁的失败项 + 上下文。主图里由门禁节点的输出直接接上。"""
    __pydantic_config__ = ConfigDict(title="审阅修复子图 · 输入")  # type: ignore[misc]
    project_root: Required[ProjectRoot]
    failures: Required[Annotated[list[Failure], Field(
        title="门禁失败项", description="上一轮 verify 报告里的 failures 数组（code / check / message / locations / detail）")]]
    requirement: Requirement
    review_backend: ReviewBackend
    spec: Annotated[str, Field(title="Spec", description="可选：生成的 Spec，审阅时只取前 2000 字")]
    attempt: Annotated[int, Field(title="第几轮", description="已失败的门禁轮数，从 1 开始")]
    baseline: Annotated[dict[str, Any], Field(
        title="编码前快照", description="可选：用于只取本次改动块；不给则与 HEAD 比较")]


class PipelineState(TypedDict, total=False):
    # 输入
    requirement: str
    project_root: str
    coding_agent: str | None
    review_backend: str | None
    fix_agent: str | None
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
    # 结果：status / break_reason 是机器可读的契约（英文），summary 给人看（中文）
    status: Literal["delivered", "broken"]
    break_reason: str
    summary: str
    history: Annotated[list[dict[str, Any]], operator.add]
