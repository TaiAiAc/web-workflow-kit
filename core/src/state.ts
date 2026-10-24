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

const value = <T>() => Annotation<T>()

export const PipelineState = Annotation.Root({
  // 输入
  requirement: value<string>(),
  project_root: value<string>(),
  coding_agent: value<string | null>(),
  review_backend: value<string | null>(),
  fix_agent: value<string | null>(),
  design_ref: value<string | null>(),
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
})

export type State = typeof PipelineState.State
export type Update = typeof PipelineState.Update
