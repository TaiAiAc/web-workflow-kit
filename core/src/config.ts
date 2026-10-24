// agent.config.json + .env 加载。路径一律解析成绝对路径。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { parse as parseEnv } from "dotenv"
import { isStage, STAGES } from "./workflow.ts"

// 默认配置、提示词、门禁脚本、控制台页面在仓库的 assets/；WWK_ASSETS 可覆盖（桌面端指向 resources/assets）
const HERE = dirname(fileURLToPath(import.meta.url))
// 打包产物（dist/wwk.mjs）旁边有 assets/；从源码跑时用仓库根目录的
export const ASSETS_DIR = process.env.WWK_ASSETS
  ?? (existsSync(join(HERE, "assets", "agent.config.json")) ? join(HERE, "assets") : resolve(HERE, "..", "..", "assets"))
export const PROMPTS_DIR = join(ASSETS_DIR, "prompts")
export const DEFAULT_CONFIG = join(ASSETS_DIR, "agent.config.json")
export const DEFAULT_RULES = join(ASSETS_DIR, "rules.yaml")
export const DEFAULT_WORKFLOW = join(ASSETS_DIR, "workflow.json")
export const VERIFY_BUNDLE = join(ASSETS_DIR, "verify.mjs")

/** 用户级配置目录：放全局 .env（SMTP、API Key），不随项目走。 */
export function userHome(): string {
  return process.env.WWK_HOME || join(homedir(), ".web-workflow-kit")
}

type Json = Record<string, any>

export const DEFAULTS: Json = JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"))
export const WORKFLOW_DEFAULTS: Json = JSON.parse(readFileSync(DEFAULT_WORKFLOW, "utf8"))

/** 把默认 rules.yaml、agent.config.json 复制到项目根目录供修改，已存在的不覆盖。返回 [目标文件, 是否新建]。 */
export function initProject(root: string): [string, boolean][] {
  return [DEFAULT_RULES, DEFAULT_CONFIG].map((src) => {
    const dst = join(root, src.split(/[\\/]/).pop()!)
    const created = !existsSync(dst)
    if (created)
      copyFileSync(src, dst)
    return [dst, created]
  })
}

function merge(base: Json, override: Json): Json {
  const out: Json = structuredClone(base)
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v
  }
  return out
}
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

export class Config {
  readonly raw: Json
  readonly projectRoot: string
  readonly stateDir: string
  readonly env: Record<string, string>
  /** .env 里每个键来自哪个文件（快照只记这个，不记值） */
  readonly envSources: Record<string, string>
  private resolvedWorkflow?: Workflow

  constructor(raw: Json, projectRoot: string, stateDir: string, env: Record<string, string> = {}, envSources: Record<string, string> = {}) {
    this.raw = raw
    this.projectRoot = projectRoot
    this.stateDir = stateDir
    this.env = env
    this.envSources = envSources
  }

  /** 生效的工作流配置；用到时才读，写坏了不影响不用它的地方（比如控制台启动）。 */
  get workflow(): Workflow {
    return this.resolvedWorkflow ??= loadWorkflow(this.projectRoot)
  }

  get(key: string): Json {
    return this.raw[key] ?? {}
  }

  /** 门禁 ⇄ 修复审阅最多几轮，来自工作流配置的 limits.max_retries */
  get maxRetries(): number {
    return Number(this.workflow.raw.limits.max_retries)
  }

  secret(name: string): string | undefined {
    return this.env[name] || process.env[name] || undefined
  }

  /** 子进程（agent、审阅、门禁）的环境：本进程环境 + 用户级 / 项目 .env，后者优先。 */
  childEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...Object.fromEntries(Object.entries(this.env).filter(([, v]) => v)) }
  }
}

/** 优先级：目标项目里的 agent.config.json > 包内默认值；.env：项目 > 用户级（~/.web-workflow-kit/.env）。 */
export function loadConfig(projectRoot?: string, configPath?: string): Config {
  let raw: Json = structuredClone(DEFAULTS)
  let root = resolve(projectRoot ?? process.cwd())
  const candidates = configPath ? [resolve(configPath)] : [join(root, "agent.config.json")]
  for (const c of candidates) {
    if (existsSync(c) && resolve(c) !== resolve(DEFAULT_CONFIG))
      raw = merge(raw, JSON.parse(readFileSync(c, "utf8")))
  }
  if (projectRoot === undefined && raw.project_root)
    root = resolve(root, raw.project_root)

  const env: Record<string, string> = {}
  const envSources: Record<string, string> = {}
  for (const [p, label] of [[join(userHome(), ".env"), tildify(join(userHome(), ".env"))], [join(root, ".env"), ".env"]]) {
    if (!existsSync(p))
      continue
    const parsed = parseEnv(readFileSync(p))
    Object.assign(env, parsed)
    for (const k of Object.keys(parsed))
      envSources[k] = label
  }

  if ("max_retries" in raw)
    throw new Error("agent.config.json 里的 max_retries 已移到工作流配置的 limits.max_retries"
      + "（控制台的工作区设置，或 ~/.web-workflow-kit/workflow.json），请从 agent.config.json 删掉这一项")

  const stateDir = resolve(root, raw.state_dir ?? ".agent")
  return new Config(raw, root, stateDir, env, envSources)
}

const tildify = (p: string): string => {
  const home = homedir()
  return p.startsWith(home + sep) ? `~${p.slice(home.length)}`.replaceAll("\\", "/") : p
}

// ---------------- 工作流配置（第二阶段） ----------------
// 三层：包内默认 assets/workflow.json < 用户级通用配置 ~/.web-workflow-kit/workflow.json < 工作区覆盖（workspaces.json
// 里该工作区的 workflowOverrides）。都存在软件里，项目内不落工作流配置。
// 合并语义：对象深合并、数组整体替换、null 照写；阶段是 map，靠 order 排序，enabled:false 关掉。

export type Layer = "default" | "user" | "workspace"

export interface Workflow {
  raw: Json
  /** 每个叶子字段（点分路径）最终来自哪一层，配置页据此显示「继承 / 已覆盖」 */
  origin: Record<string, Layer>
}

export const userWorkflowFile = (): string => join(userHome(), "workflow.json")
export const workspacesFile = (): string => join(userHome(), "workspaces.json")

/** 同一个目录只算一个工作区：统一成绝对路径、正斜杠，~ 展开成用户目录。 */
export function workspaceKey(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const p = path.startsWith("~") ? home + path.slice(1) : path
  return resolve(p).replaceAll("\\", "/").replace(/(.)\/+$/, "$1")
}

/** workspaces.json 的条目；文件不存在或写坏了当作空列表。 */
export function workspaceEntries(): Json[] {
  try {
    const data = JSON.parse(readFileSync(workspacesFile(), "utf8"))
    return Array.isArray(data) ? data.filter(w => isObject(w) && w.path) : []
  }
  catch {
    return []
  }
}

export function workspaceOverrides(root: string): Json {
  const key = workspaceKey(root)
  const ws = workspaceEntries().find(w => w.path === key)
  return isObject(ws?.workflowOverrides) ? ws.workflowOverrides : {}
}

export function readUserWorkflow(): Json {
  const f = userWorkflowFile()
  if (!existsSync(f))
    return {}
  let data: unknown
  try {
    data = JSON.parse(readFileSync(f, "utf8"))
  }
  catch (e) {
    throw new Error(`通用工作流配置不是合法 JSON：${f}（${(e as Error).message}）`)
  }
  if (!isObject(data))
    throw new Error(`通用工作流配置必须是对象：${f}`)
  return data
}

/** 写用户级通用配置；先和每个工作区的覆盖一起校验，任何一个合不出合法配置就不写。 */
export function saveUserWorkflow(data: Json): void {
  resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["user", data]])
  for (const ws of workspaceEntries()) {
    if (!isObject(ws.workflowOverrides))
      continue
    try {
      resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["user", data], ["workspace", ws.workflowOverrides]])
    }
    catch (e) {
      throw new Error(`与工作区 ${ws.path} 的覆盖合并后不合法：${(e as Error).message}`)
    }
  }
  writeJsonAtomic(userWorkflowFile(), data)
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), "utf8")
  renameSync(`${path}.tmp`, path)
}

export function loadWorkflow(projectRoot: string): Workflow {
  return resolveWorkflow([
    ["default", WORKFLOW_DEFAULTS],
    ["user", readUserWorkflow()],
    ["workspace", workspaceOverrides(projectRoot)],
  ])
}

export function resolveWorkflow(layers: [Layer, Json][]): Workflow {
  let raw: Json = {}
  const origin: Record<string, Layer> = {}
  for (const [layer, data] of layers) {
    raw = merge(raw, data)
    markOrigin(data, layer, "", origin)
  }
  validateWorkflow(raw)
  return { raw, origin }
}

function markOrigin(data: Json, layer: Layer, prefix: string, origin: Record<string, Layer>): void {
  for (const [k, v] of Object.entries(data)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (isObject(v)) {
      delete origin[p] // 原来是叶子、现在换成了对象
      markOrigin(v, layer, p, origin)
      continue
    }
    for (const old of Object.keys(origin)) { // 原来是对象、现在换成了叶子：下面的旧来源作废
      if (old.startsWith(`${p}.`))
        delete origin[old]
    }
    origin[p] = layer
  }
}

/** 一次列出所有问题，配置页可以整段展示。 */
export function validateWorkflow(w: Json): void {
  const errors: string[] = []
  const need = (ok: boolean, msg: string): void => {
    if (!ok)
      errors.push(msg)
  }
  const int = (v: unknown, min: number): boolean => Number.isInteger(v) && (v as number) >= min
  const has = (o: Json, k: unknown): boolean => typeof k === "string" && Object.hasOwn(o, k)

  need(w.version === 2, `version 必须是 2（当前 ${JSON.stringify(w.version)}）`)
  need(isObject(w.roles), "roles 必须是对象")
  const roles: Json = isObject(w.roles) ? w.roles : {}
  for (const [name, r] of Object.entries(roles))
    need(isObject(r) && typeof r.agent === "string" && r.agent.trim() !== "", `roles.${name}.agent 不能为空`)

  need(isObject(w.stages), "stages 必须是对象")
  const orders = new Map<number, string>()
  for (const [name, s] of Object.entries(isObject(w.stages) ? w.stages : {})) {
    const p = `stages.${name}`
    if (!isStage(name)) {
      errors.push(`${p}：未知阶段（可选：${STAGES.join(" / ")}）`)
      continue
    }
    if (!isObject(s)) {
      errors.push(`${p} 必须是对象`)
      continue
    }
    need(s.enabled === undefined || typeof s.enabled === "boolean", `${p}.enabled 必须是 true / false`)
    need(typeof s.order === "number" && Number.isFinite(s.order), `${p}.order 必须是数字`)
    need(s.role !== undefined || s.kind !== undefined, `${p} 需要 role 或 kind`)
    need(s.role === undefined || has(roles, s.role), `${p}.role 不在 roles 里：${s.role}`)
    need(s.on_exceed === undefined || has(roles, s.on_exceed), `${p}.on_exceed 不在 roles 里：${s.on_exceed}`)
    need(s.max_rounds === undefined || int(s.max_rounds, 1), `${p}.max_rounds 必须是 ≥ 1 的整数`)
    need(s.install_command === undefined || s.install_command === null
      || (typeof s.install_command === "string" && s.install_command.trim() !== ""), `${p}.install_command 只能是 "auto"、命令字符串或 null`)
    if (s.enabled !== false && typeof s.order === "number") {
      const dup = orders.get(s.order)
      need(dup === undefined, `${p}.order 与 stages.${dup} 重复：${s.order}`)
      orders.set(s.order, name)
    }
  }

  const stages: Json = isObject(w.stages) ? w.stages : {}
  need(isObject(stages.gate) && stages.gate.enabled !== false, "stages.gate 不能关：门禁是唯一的放行依据")
  // 阶段顺序是定死的（第二节「不可改的决策」）；order 只用来排序和合并，不能把阶段调到别的阶段前面
  const enabled = STAGES.filter(n => isObject(stages[n]) && stages[n].enabled !== false && typeof stages[n].order === "number")
  const sorted = [...enabled].sort((a, b) => stages[a].order - stages[b].order)
  need(sorted.every((n, i) => n === enabled[i]), `阶段顺序不能改，应为 ${enabled.join(" → ")}（当前按 order 是 ${sorted.join(" → ")}）`)

  const git: Json = isObject(w.git) ? w.git : {}
  need(git.merge_method === "squash", `git.merge_method 目前只支持 squash（当前 ${JSON.stringify(git.merge_method)}）`)
  need(typeof git.branch_prefix === "string" && git.branch_prefix.trim() !== "", "git.branch_prefix 不能为空")
  need(int(git.keep_failed_branches, 0), "git.keep_failed_branches 必须是 ≥ 0 的整数")

  const limits: Json = isObject(w.limits) ? w.limits : {}
  need(int(limits.max_retries, 1), "limits.max_retries 必须是 ≥ 1 的整数")
  need(int(limits.max_doc_lint_failures, 1), "limits.max_doc_lint_failures 必须是 ≥ 1 的整数")
  need(int(limits.token_budget, 0), "limits.token_budget 必须是 ≥ 0 的整数（0 = 不限）")
  need(int(limits.time_budget_sec, 0), "limits.time_budget_sec 必须是 ≥ 0 的整数（0 = 不限）")

  const vision: Json = isObject(w.vision) ? w.vision : {}
  need(typeof vision.timeout_sec === "number" && vision.timeout_sec > 0, "vision.timeout_sec 必须是正数")

  if (errors.length)
    throw new Error(`工作流配置有误：\n- ${errors.join("\n- ")}`)
}

// ---------------- 生效快照 ----------------

export const REDACTED = "[redacted]"
// 字段名像密钥的一律打码；api_key_env / env_keys 这类「存放密钥的变量名」不算
const SECRET_NAME = /(?:api_?key|secret|token|passw(?:or)?d|(?:^|_)pass)$/i

/** 递归打码：字段名像密钥的，或值里含已知密钥的。 */
export function redact<T>(value: T, secrets: string[] = [], key = ""): T {
  if (Array.isArray(value))
    return value.map(v => redact(v, secrets)) as T
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets, k)])) as T
  if (typeof value === "string" && value && ((key && SECRET_NAME.test(key)) || secrets.some(s => value.includes(s))))
    return REDACTED as T
  return value
}

/** 本进程能拿到的密钥值（.env 和进程环境里名字像密钥的），用来在快照 / 导出里认出被抄进配置的密钥。 */
export function knownSecrets(env: Record<string, string | undefined> = {}): string[] {
  const values = new Set<string>()
  for (const source of [process.env, env]) {
    for (const [k, v] of Object.entries(source)) {
      if (v && v.length >= 6 && SECRET_NAME.test(k))
        values.add(v)
    }
  }
  return [...values]
}

/** 本次运行的生效配置：工作流（含每个字段的来源）+ agent.config.json；密钥只记「来自哪个文件的哪个键」。 */
export function configSnapshot(cfg: Config): Json {
  const secrets = knownSecrets(cfg.env)
  const wf = cfg.workflow
  const user = userWorkflowFile()
  const overrides = workspaceOverrides(cfg.projectRoot)
  return {
    generated_at: new Date().toISOString(),
    project_root: cfg.projectRoot,
    sources: {
      default: DEFAULT_WORKFLOW,
      user: existsSync(user) ? tildify(user) : null,
      workspace: Object.keys(overrides).length ? workspaceKey(cfg.projectRoot) : null,
    },
    workflow: redact(wf.raw, secrets),
    origin: wf.origin,
    agent_config: redact(cfg.raw, secrets),
    env: Object.fromEntries(Object.keys(cfg.envSources).sort().map(k => [k, cfg.envSources[k]])),
  }
}

/** 写到 .agent/runs/<id>/config.snapshot.json，返回路径。 */
export function writeSnapshot(cfg: Config, runId: string): string {
  const path = join(cfg.stateDir, "runs", runId, "config.snapshot.json")
  writeText(path, `${JSON.stringify(configSnapshot(cfg), null, 2)}\n`)
  return path
}

/** {key} 占位替换；不用模板引擎，避免 Markdown 里的 JSON 花括号被误解析。 */
export function render(template: string, values: Record<string, unknown>): string {
  let out = template
  for (const [k, v] of Object.entries(values))
    out = out.replaceAll(`{${k}}`, typeof v === "string" ? v : JSON.stringify(v, null, 2))
  return out
}

export function prompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf8")
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, "utf8")
}

/** 相对项目根目录的路径；不在项目里返回绝对路径（正斜杠）。 */
export function relativeTo(path: string, root: string): string {
  const p = resolve(path).replaceAll("\\", "/")
  const r = resolve(root).replaceAll("\\", "/").replace(/\/$/, "")
  return p.startsWith(r + "/") ? p.slice(r.length + 1) : p
}

export const absoluteIn = (root: string, p: string): string => (isAbsolute(p) ? p : join(root, p))
