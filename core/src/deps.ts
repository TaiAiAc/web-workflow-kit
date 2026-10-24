// 节点依赖的外部能力。图只依赖这里的接口，测试时整体替换成假实现。
import { type Agent, buildAgent, buildCodingAgent, ClaudeCodeCLI, END_TURN } from "./agents.ts"
import { type Config, loadConfig, prompt, render } from "./config.ts"
import { loadDesign } from "./design.ts"
import { type Failure, type GateResult, runGate } from "./gate.ts"
import { chat, LLMError } from "./llm.ts"
import type { Metrics } from "./metrics.ts"
import { notifyBreaker } from "./notify.ts"
import { makeReviewer, type Plan } from "./review.ts"

const VERDICTS = new Set(["fixable", "needs_human"])

export interface Deps {
  cfg: Config
  design: (ref: string | null | undefined) => Promise<Record<string, unknown> | null>
  spec: (requirement: string, design: Record<string, unknown> | null) => Promise<string>
  coder: Agent
  gate: () => Promise<GateResult>
  reviewer: (payload: Record<string, unknown>) => Promise<Plan>
  fixer: Agent
  notifier: (state: Record<string, any>) => Promise<string>
  log: (line: string) => void
  /** 作业分支上的阶段提交（控制台的完整流水线才有）；越界抛 WhitelistError，没改动返回 null */
  commit?: (source: "implement" | "gate-fix", round: number, summary: string) => string | null
  /** 指标：每次 agent 调用和每次打回 */
  metrics?: Metrics
  /** 指标里显示的 agent 名（预设 key） */
  agentNames?: { coder: string, fixer: string }
}

function specFn(cfg: Config) {
  const scfg = cfg.get("spec")
  const system = prompt("spec-prompt.md")
  return async (requirement: string, design: Record<string, unknown> | null): Promise<string> => {
    const user = JSON.stringify({ requirement, project_type: cfg.get("verify").type || "见 rules.yaml", design }, null, 2)
    if (scfg.backend === "openai_compatible") {
      const keyEnv = scfg.api_key_env ?? "OPENAI_API_KEY"
      const key = cfg.secret(keyEnv)
      if (!key)
        throw new Error(`${keyEnv} is not set`)
      return chat(scfg.base_url, key, scfg.model, system, user, { timeoutSec: Number(scfg.timeout_sec ?? 600) })
    }
    // 默认 Claude Code 只读跑一次：-p 模式下未授权的编辑会被拒绝，只会读仓库
    const agent = new ClaudeCodeCLI({ model: scfg.model, maxTurns: 20, timeoutSec: Number(scfg.timeout_sec ?? 600), env: cfg.childEnv() })
    const r = await agent.run(`${system}\n\n## 输入\n\n\`\`\`json\n${user}\n\`\`\`\n\n只输出 Spec 正文，不要修改任何文件。`, cfg.projectRoot)
    if (r.stopReason !== END_TURN)
      throw new Error(`spec agent stop_reason=${r.stopReason}: ${r.text.slice(-500)}`)
    return r.text
  }
}

export function validatePlan(plan: unknown): Plan {
  const p = plan as Plan
  if (!p || typeof p !== "object" || !VERDICTS.has(p.verdict) || !Array.isArray(p.fixes ?? []))
    throw new LLMError(`review output violates schema: ${JSON.stringify(plan).slice(0, 300)}`)
  p.fixes ??= []
  delete p.pass // 顾问无放行权，任何 pass 字段直接丢弃
  return p
}

export interface DepsOptions {
  log?: (line: string) => void
  codingAgent?: string | null
  reviewBackend?: string | null
  fixAgent?: string | null
  commit?: Deps["commit"]
  metrics?: Metrics
}

export function defaultDeps(cfg: Config, opts: DepsOptions = {}): Deps {
  const log = opts.log ?? ((line: string) => console.log(line))
  return {
    cfg,
    design: ref => loadDesign(ref, cfg),
    spec: specFn(cfg),
    coder: buildCodingAgent(cfg, opts.codingAgent),
    gate: () => runGate(cfg, { log }),
    reviewer: makeReviewer(cfg, opts.reviewBackend, validatePlan),
    fixer: buildFixAgent(cfg, opts.fixAgent),
    notifier: state => notifyBreaker(state, cfg),
    log,
    commit: opts.commit,
    metrics: opts.metrics,
    agentNames: { coder: opts.codingAgent || cfg.get("code").agent || "claude", fixer: opts.fixAgent || "fix" },
  }
}

/** “修复”的 agent：不选用 fix 段本身（默认 dsh）；选了就用同名预设，超时仍取 fix 段。 */
export function buildFixAgent(cfg: Config, choice?: string | null): Agent {
  const fix = cfg.get("fix")
  if (!choice)
    return buildAgent(fix, cfg, "fix-task")
  const presets: Record<string, any> = cfg.raw.coding_agents ?? {}
  if (!(choice in presets))
    throw new Error(`未知的修复 agent：${choice}（可选：${Object.keys(presets).join(", ")}）`)
  return buildAgent({ ...(fix.timeout_sec ? { timeout_sec: fix.timeout_sec } : {}), ...presets[choice] }, cfg, "fix-task")
}

/** 服务端用：每次运行按输入里的 project_root 加载该项目的配置，不缓存。 */
export function depsFromState(state: Record<string, any>, log?: (line: string) => void): Deps {
  if (!state.project_root)
    throw new Error("input.project_root is required: the absolute path of the front-end project to work on")
  return defaultDeps(loadConfig(state.project_root), {
    log, codingAgent: state.coding_agent, reviewBackend: state.review_backend, fixAgent: state.fix_agent,
  })
}

export function codePrompt(requirement: string, spec: string): string {
  return render(prompt("code-prompt.md"), { requirement, spec })
}

export function fixPrompt(attempt: number, maxAttempts: number, failures: Failure[], plan: Plan | null | undefined): string {
  return render(prompt("fix-prompt.md"), { attempt: String(attempt), max_attempts: String(maxAttempts), failures, plan: plan ?? {} })
}
