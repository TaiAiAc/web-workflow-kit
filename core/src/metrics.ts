// 指标与打回原因（第二阶段）：每次 agent 调用记阶段、agent、轮次、耗时、token；每次打回记谁的产出、被谁、因为什么。
// 每次运行一份 .agent/runs/<id>/metrics.jsonl，按 agent 汇总给控制台看；轮次上限等参数靠这些真实数据再调。
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Agent, AgentResult, Usage } from "./agent-result.ts"

/** 打回来自哪里 */
export type RejectBy = "lint" | "doc-review" | "arbiter" | "impl-review" | "gate" | "acceptance" | "whitelist"

export type MetricEvent =
  | { kind: "agent", at: string, stage: string, role: string, agent: string, round: number, ms: number, usage: Usage | null, stop_reason: string }
  | { kind: "reject", at: string, stage: string, round: number, by: RejectBy, agent: string | null, reasons: string[] }

export class Metrics {
  readonly file: string | null

  /** file 为 null 时只在内存里记（测试、命令行不落盘时） */
  constructor(file: string | null) {
    this.file = file
  }

  readonly events: MetricEvent[] = []

  private push(e: MetricEvent): void {
    this.events.push(e)
    if (!this.file)
      return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(e)}\n`)
    }
    catch {} // 指标写不进去不影响流水线
  }

  agentCall(stage: string, role: string, agent: string, round: number, ms: number, result: Pick<AgentResult, "stopReason" | "usage">): void {
    this.push({ kind: "agent", at: new Date().toISOString(), stage, role, agent, round, ms, usage: result.usage ?? null, stop_reason: result.stopReason })
  }

  reject(stage: string, round: number, by: RejectBy, agent: string | null, reasons: string[]): void {
    this.push({ kind: "reject", at: new Date().toISOString(), stage, round, by, agent, reasons: reasons.map(r => r.slice(0, 300)) })
  }

  /** 给 agent 套一层计量；round 每次调用时取（同一个 agent 会在多轮里被调用） */
  wrap(agent: Agent, stage: string, role: string, name: string, round: () => number): Agent {
    return {
      run: async (prompt: string, cwd: string) => {
        const t = Date.now()
        const r = await agent.run(prompt, cwd)
        this.agentCall(stage, role, name, round(), Date.now() - t, r)
        return r
      },
    }
  }
}

export const metricsFile = (stateDir: string, runId: string): string => join(stateDir, "runs", runId, "metrics.jsonl")

export interface AgentSummary {
  agent: string
  calls: number
  errors: number
  ms: number
  /** 拿到用量的调用才计入；没有的（如 dsh）不算 */
  tokens: { input: number, output: number, total: number, calls_with_usage: number }
  /** 这个 agent 的产出被打回的次数，按来源分 */
  rejected: Partial<Record<RejectBy, number>>
  /** 最常见的打回原因（按出现次数） */
  top_reasons: { reason: string, count: number }[]
  roles: string[]
}

/** 汇总一个项目所有运行的指标，按 agent 分组；runs 限定最近几次。 */
export function summarize(stateDir: string, opts: { runs?: number } = {}): { runs: number, agents: AgentSummary[] } {
  let ids: string[]
  try {
    ids = readdirSync(join(stateDir, "runs"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  }
  catch {
    return { runs: 0, agents: [] }
  }
  const perRun: MetricEvent[][] = []
  for (const id of ids) {
    try {
      const lines = readFileSync(metricsFile(stateDir, id), "utf8").split("\n").filter(Boolean)
      perRun.push(lines.map(l => JSON.parse(l) as MetricEvent))
    }
    catch {}
  }
  perRun.sort((a, b) => (b[0]?.at ?? "").localeCompare(a[0]?.at ?? ""))
  const picked = opts.runs ? perRun.slice(0, opts.runs) : perRun
  const by = new Map<string, AgentSummary & { reasons: Map<string, number> }>()
  const get = (agent: string) => {
    let s = by.get(agent)
    if (!s) {
      s = { agent, calls: 0, errors: 0, ms: 0, tokens: { input: 0, output: 0, total: 0, calls_with_usage: 0 }, rejected: {}, top_reasons: [], roles: [], reasons: new Map() }
      by.set(agent, s)
    }
    return s
  }
  for (const e of picked.flat()) {
    if (e.kind === "agent") {
      const s = get(e.agent)
      s.calls++
      s.ms += e.ms
      if (e.stop_reason !== "end_turn")
        s.errors++
      if (!s.roles.includes(e.role))
        s.roles.push(e.role)
      if (e.usage && (e.usage.total ?? e.usage.input ?? e.usage.output) != null) {
        s.tokens.calls_with_usage++
        s.tokens.input += e.usage.input ?? 0
        s.tokens.output += e.usage.output ?? 0
        s.tokens.total += e.usage.total ?? ((e.usage.input ?? 0) + (e.usage.output ?? 0))
      }
    }
    else if (e.agent) {
      const s = get(e.agent)
      s.rejected[e.by] = (s.rejected[e.by] ?? 0) + 1
      for (const r of e.reasons)
        s.reasons.set(r, (s.reasons.get(r) ?? 0) + 1)
    }
  }
  const agents = [...by.values()].map(({ reasons, ...s }) => ({
    ...s,
    top_reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count })),
  })).sort((a, b) => b.calls - a.calls)
  return { runs: picked.length, agents }
}
