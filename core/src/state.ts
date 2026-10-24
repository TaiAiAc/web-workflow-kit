// 图状态。字段名是对外契约（控制台、检查点、Studio 都按它取值），保持英文。
import { Annotation } from "@langchain/langgraph"
import type { Baseline } from "./diffs.ts"
import type { Failure } from "./gate.ts"
import type { Plan } from "./review.ts"

export interface HistoryItem {
  attempt: number
  exit: number
  codes: string[]
}

export type StageStatus = "done" | "failed" | "skipped"

const value = <T>() => Annotation<T>()

export const PipelineState = Annotation.Root({
  // 输入
  requirement: value<string>(),
  project_root: value<string>(),
  coding_agent: value<string | null>(),
  review_backend: value<string | null>(),
  fix_agent: value<string | null>(),
  // 文档阶段各角色本次用的 agent；不填用工作流配置的 roles
  product_agent: value<string | null>(),     // 需求 / 复核 / 验收（同一个 agent）
  tech_agent: value<string | null>(),        // 技术设计 / 实现核对
  vision_agent: value<string | null>(),      // 看图
  arbiter_agent: value<string | null>(),     // 仲裁
  design_ref: value<string | null>(),
  // 第二阶段的输入与文档
  input_mode: value<"text" | "image" | "mastergo" | null>(),
  images: value<string[] | null>(),           // 图片输入（绝对路径）
  docs_dir: value<string | null>(),           // 入库文档目录（相对项目根目录）
  artifacts: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }), // 文档编号 → 绝对路径
  doc_round: value<number>(),                 // 文档复核已进行的轮数
  review_verdict: value<"approved" | "rejected" | null>(),
  acceptance_round: value<number>(),          // 产品验收已进行的轮数
  acceptance_verdict: value<"pass" | "fail" | null>(),
  return_stage: value<string | null>(),       // 验收打回到哪个阶段
  feedback: value<string | null>(),           // 打回 / 仲裁留给下一阶段的话
  impl_round: value<number>(),                // 实现核对已进行的轮数
  impl_verdict: value<"match" | "mismatch" | null>(),
  impl_feedback: value<string | null>(),      // 实现核对指出的问题，交回编码
  // codegraph
  design: value<Record<string, unknown> | null>(),
  spec: value<string>(),
  baseline: value<Baseline | null>(),       // 编码前的工作区快照，用于只取本次改动块
  code_stop_reason: value<string>(),
  // 门禁
  attempt: value<number>(),                 // 已失败的门禁轮数，代码强制熔断依据
  verify_exit: value<number>(),             // verify.ts 退出码：唯一放行依据
  failures: value<Failure[]>(),             // 只保留失败项
  // reviewgraph
  plan: value<Plan | null>(),
  fix_stop_reason: value<string>(),
  // 结果：status / break_reason 是机器可读的契约（英文），summary 给人看（中文）
  status: value<"delivered" | "broken">(),
  break_reason: value<string>(),
  summary: value<string>(),
  changed_files: value<string[]>(),
  history: Annotation<HistoryItem[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  // 每个阶段的结果（阶段名见 workflow.ts）；按键合并，后写的覆盖先写的
  stage_status: Annotation<Record<string, StageStatus>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
})

export type State = typeof PipelineState.State
export type Update = typeof PipelineState.Update
