// 测试公用：临时目录、假 agent、假门禁。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { after } from "node:test"
import { type Agent, type AgentResult, END_TURN } from "../src/agents.ts"
import { type Config, loadConfig } from "../src/config.ts"
import type { Deps } from "../src/deps.ts"
import { type Failure, GateResult } from "../src/gate.ts"
import type { Plan } from "../src/review.ts"

// 不读真实的 ~/.web-workflow-kit/.env（里面可能有 API Key）
process.env.WWK_HOME = mkdtempSync(join(tmpdir(), "wwk-home-"))

const dirs: string[] = []
// Windows 上刚结束的子进程可能还占着目录（taskkill 是异步的）：重试几次，仍删不掉就留给系统清临时目录
after(() => dirs.forEach((d) => {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  catch {}
}))

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wwk-core-"))
  dirs.push(d)
  return d
}

export class FakeAgent implements Agent {
  readonly reason: string
  readonly calls: string[] = []
  constructor(reason = END_TURN) {
    this.reason = reason
  }

  async run(prompt: string): Promise<AgentResult> {
    this.calls.push(prompt)
    return { stopReason: this.reason, text: "" }
  }
}

export const FAIL = new GateResult(1, [{ code: "TYPECHECK_FAIL", check: "typecheck", message: "x", locations: ["src/a.ts:1"] } as Failure])
export const PASS = new GateResult(0, [])

export const DOC_STAGES = ["discovery", "tech-design", "doc-review", "acceptance"] as const

/** 关掉文档阶段：测试里不调真实的 product / tech agent */
export function disableDocStages(workflow: Record<string, any>): void {
  for (const n of DOC_STAGES)
    workflow.stages[n].enabled = false
}

export function makeDeps(tmp: string, gates: GateResult[], opts: {
  plan?: Plan
  coder?: FakeAgent
  fixer?: FakeAgent
  maxRetries?: number
  /** 默认关掉文档阶段（取材、技术设计、复核、验收），只测编码 ⇄ 门禁；文档阶段的测试传 true */
  docStages?: boolean
} = {}): { deps: Deps, sent: Record<string, any>[], cfg: Config } {
  const cfg = loadConfig(tmp)
  cfg.workflow.raw.limits.max_retries = opts.maxRetries ?? 3
  if (!opts.docStages)
    disableDocStages(cfg.workflow.raw)
  const queue = [...gates]
  const sent: Record<string, any>[] = []
  const deps: Deps = {
    cfg,
    design: async () => null,
    spec: async req => `spec for ${req}`,
    coder: opts.coder ?? new FakeAgent(),
    gate: async () => {
      const g = queue.shift()
      if (!g)
        throw new Error("gate called more times than scripted")
      return g
    },
    reviewer: async () => structuredClone(opts.plan ?? { verdict: "fixable", summary: "s", fixes: [] }),
    fixer: opts.fixer ?? new FakeAgent(),
    notifier: async (state) => {
      sent.push(state)
      return "sent"
    },
    log: () => {},
  }
  return { deps, sent, cfg }
}
