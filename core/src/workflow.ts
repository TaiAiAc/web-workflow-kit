// 阶段注册表：第二阶段的六个阶段、在主图里的节点名、是否已实现。
// 主图按生效的工作流配置拼出来：只取启用的阶段，按 order 排；顺序本身不可改（validateWorkflow 把关）。
import type { Entry } from "./checkpoint.ts"
import type { Workflow } from "./config.ts"
import * as N from "./names.ts"

export const STAGES = ["discovery", "tech-design", "doc-review", "implement", "gate", "acceptance"] as const
export type StageName = typeof STAGES[number]

/** 阶段在主图里的入口节点名；implement / gate 沿用第一阶段的节点，控制台、Studio、检查点都不受影响。 */
export const STAGE_NODE: Record<StageName, string> = {
  "discovery": N.DISCOVERY,
  "tech-design": N.TECH_DESIGN,
  "doc-review": N.DOC_REVIEW,
  "implement": N.CODE,
  "gate": N.VERIFY,
  "acceptance": N.ACCEPTANCE,
}

/** 已有实现的阶段；其余阶段启用时在主图里是一个直接跳过的节点，后续步骤逐个补上。 */
export const IMPLEMENTED: ReadonlySet<StageName> = new Set(["implement", "gate"])

export interface PlannedStage {
  name: StageName
  node: string
  implemented: boolean
  config: Record<string, any>
}

export const isStage = (name: string): name is StageName => (STAGES as readonly string[]).includes(name)

/** 本次运行要走的阶段。entry="verify"（门禁修复回环）只走门禁。 */
export function stagePlan(wf: Workflow, entry: Entry = "code"): PlannedStage[] {
  const stages: Record<string, any> = wf.raw.stages
  const enabled = STAGES.filter(n => stages[n] && stages[n].enabled !== false)
    .sort((a, b) => stages[a].order - stages[b].order)
  return enabled.filter(n => entry === "code" || n === "gate")
    .map(name => ({ name, node: STAGE_NODE[name], implemented: IMPLEMENTED.has(name), config: stages[name] }))
}
