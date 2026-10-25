// 节点依赖的外部能力。图只依赖这里的接口，测试时整体替换成假实现。
import { type Agent, buildAgent, buildCodingAgent, ClaudeCodeCLI, END_TURN } from "./agents.ts"
import { type Config, loadConfig, prompt, render } from "./config.ts"
import { loadDesign } from "./design.ts"
import { type Failure, type GateResult, runGate } from "./gate.ts"
import { chat, LLMError } from "./llm.ts"
import type { Metrics } from "./metrics.ts"
import { buildRoleAgent, type RoleAgent } from "./stages.ts"
import { analyzeImages, type VisionInput, type VisionResult } from "./vision.ts"
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
  commit?: (source: "discovery" | "tech-design" | "implement" | "gate-fix", round: number, summary: string) => string | null
  /** 指标：每次 agent 调用和每次打回 */
  metrics?: Metrics
  /** 指标里显示的 agent 名（预设 key） */
  agentNames?: { coder: string, fixer: string }
  /** 文档阶段按角色取只读 agent（product / tech / arbiter……） */
  roleAgent?: (role: string) => RoleAgent
  /** 看图出 01 */
  vision?: (input: VisionInput) => Promise<VisionResult>
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

/** 运行输入 / 工作空间偏好里各角色的字段名 */
export const ROLE_INPUTS = { product: "product_agent", tech: "tech_agent", vision: "vision_agent", arbiter: "arbiter_agent" } as const
export type RoleOverrides = Partial<Record<keyof typeof ROLE_INPUTS, string | null>>
export const ROLE_FIELDS = {
  product: { agent: "product_agent", model: "product_model", effort: "product_effort" },
  tech: { agent: "tech_agent", model: "tech_model", effort: "tech_effort" },
  coding: { agent: "coding_agent", model: "coding_model", effort: "coding_effort" },
  fix: { agent: "fix_agent", model: "fix_model", effort: "fix_effort" },
  review: { agent: "review_backend", model: "review_model", effort: "review_effort" },
  vision: { agent: "vision_agent", model: "vision_model", effort: "vision_effort" },
  arbiter: { agent: "arbiter_agent", model: "arbiter_model", effort: "arbiter_effort" },
} as const
export type RoleName = keyof typeof ROLE_FIELDS
export interface AgentSelection {
  agent?: string | null
  model?: string | null
  effort?: string | null
}
export type RoleSelections = Partial<Record<RoleName, AgentSelection>>
/** 从运行输入（或多份，前面的优先）里取各角色本次选的 agent */
export function roleOverrides(...sources: Record<string, any>[]): RoleOverrides {
  return Object.fromEntries(Object.entries(ROLE_INPUTS).map(([role, k]) => [role, sources.map(s => s?.[k]).find(Boolean) ?? null]))
}

/** 从运行输入 / 工作区偏好里取每个角色的 agent、模型和思考强度；空值代表继承。 */
export function roleSelections(...sources: Record<string, any>[]): RoleSelections {
  return Object.fromEntries(Object.entries(ROLE_FIELDS).flatMap(([role, fields]) => {
    const selection = Object.fromEntries(Object.entries(fields).map(([kind, field]) => [
      kind,
      sources.map(source => source?.[field]).find(value => value !== undefined && value !== null && value !== "") ?? null,
    ])) as AgentSelection
    return Object.values(selection).some(Boolean) ? [[role, selection]] : []
  }))
}

/** 工作流 roles 提供默认值，本次运行 / 工作区偏好覆盖它。 */
export function roleSelection(cfg: Config, role: string, selected?: AgentSelection): AgentSelection {
  const defaults: AgentSelection = cfg.workflow.raw.roles?.[role] ?? {}
  const agentChanged = Boolean(selected?.agent && defaults.agent && selected.agent !== defaults.agent)
  return {
    agent: selected?.agent || defaults.agent || null,
    // 角色默认值是给默认 agent 配的；换了 agent 后不能把不兼容的模型设置硬套过去。
    model: selected?.model || (agentChanged ? null : defaults.model) || null,
    effort: selected?.effort || (agentChanged ? null : defaults.effort) || null,
  }
}

export interface DepsOptions {
  log?: (line: string) => void
  codingAgent?: string | null
  reviewBackend?: string | null
  fixAgent?: string | null
  commit?: Deps["commit"]
  metrics?: Metrics
  /** 文档阶段各角色本次用的 agent，覆盖工作流配置的 roles */
  roles?: RoleOverrides
  /** 所有可配置角色的 agent + model + effort；空字段继承工作流 roles */
  selections?: RoleSelections
}

export function defaultDeps(cfg: Config, opts: DepsOptions = {}): Deps {
  const log = opts.log ?? ((line: string) => console.log(line))
  // 写代码的 agent：本次运行选的 > 工作流配置里 dev 角色的 > agent.config.json 的 code.agent
  const coding = roleSelection(cfg, "dev", opts.selections?.coding ?? (opts.codingAgent ? { agent: opts.codingAgent } : undefined))
  const coder = opts.codingAgent || coding.agent || cfg.get("code").agent || "claude"
  const codingOptions = { model: coding.model, effort: coding.effort }
  const fix = roleSelection(cfg, "fix", opts.selections?.fix ?? (opts.fixAgent ? { agent: opts.fixAgent } : undefined))
  const fixKey = opts.fixAgent || fix.agent
  const review = roleSelection(cfg, "review", opts.selections?.review ?? (opts.reviewBackend ? { agent: opts.reviewBackend } : undefined))
  const visionSelected = opts.roles?.vision
    ? { ...(opts.selections?.vision ?? {}), agent: opts.roles.vision }
    : opts.selections?.vision
  const vision = roleSelection(cfg, "vision", visionSelected)
  return {
    cfg,
    design: ref => loadDesign(ref, cfg),
    spec: specFn(cfg),
    coder: buildCodingAgent(cfg, coder, codingOptions),
    gate: () => runGate(cfg, { log }),
    reviewer: makeReviewer(cfg, opts.reviewBackend, validatePlan, { model: review.model, effort: review.effort }),
    fixer: buildFixAgent(cfg, fixKey, { model: fix.model, effort: fix.effort }),
    notifier: state => notifyBreaker(state, cfg),
    log,
    commit: opts.commit,
    metrics: opts.metrics,
    agentNames: { coder, fixer: fixKey || "fix" },
    roleAgent: role => buildRoleAgent(cfg, role, opts.roles?.[role as keyof RoleOverrides], opts.selections?.[role as RoleName]),
    vision: input => analyzeImages(cfg, input, {
      log,
      agent: opts.roles?.vision || vision.agent,
      model: vision.model,
      effort: vision.effort,
    }),
  }
}

/** “修复”的 agent：不选用 fix 段本身（默认 dsh）；选了就用同名预设，超时仍取 fix 段。 */
export function buildFixAgent(cfg: Config, choice?: string | null, options: { model?: string | null, effort?: string | null } = {}): Agent {
  const fix = cfg.get("fix")
  if (!choice)
    return buildAgent({ ...fix, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value)) }, cfg, "fix-task")
  const presets: Record<string, any> = cfg.raw.coding_agents ?? {}
  if (!(choice in presets))
    throw new Error(`未知的修复 agent：${choice}（可选：${Object.keys(presets).join(", ")}）`)
  return buildAgent({
    ...(fix.timeout_sec ? { timeout_sec: fix.timeout_sec } : {}),
    ...presets[choice],
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value)),
  }, cfg, "fix-task")
}

/** 服务端用：每次运行按输入里的 project_root 加载该项目的配置，不缓存。 */
export function depsFromState(state: Record<string, any>, log?: (line: string) => void): Deps {
  if (!state.project_root)
    throw new Error("input.project_root is required: the absolute path of the front-end project to work on")
  return defaultDeps(loadConfig(state.project_root), {
    log,
    codingAgent: state.coding_agent,
    reviewBackend: state.review_backend,
    fixAgent: state.fix_agent,
    roles: roleOverrides(state),
    selections: roleSelections(state),
  })
}

export function codePrompt(requirement: string, spec: string, selfTest = ""): string {
  return render(prompt("code-prompt.md"), { requirement, spec, self_test: selfTest })
}

export function fixPrompt(attempt: number, maxAttempts: number, failures: Failure[], plan: Plan | null | undefined): string {
  return render(prompt("fix-prompt.md"), { attempt: String(attempt), max_attempts: String(maxAttempts), failures, plan: plan ?? {} })
}
