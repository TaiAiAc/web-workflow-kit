// agent.config.json + .env 加载。路径一律解析成绝对路径。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { parse as parseEnv } from "dotenv"

// 默认配置、提示词、门禁脚本、控制台页面在仓库的 assets/；WWK_ASSETS 可覆盖（桌面端指向 resources/assets）
const HERE = dirname(fileURLToPath(import.meta.url))
// 打包产物（dist/wwk.mjs）旁边有 assets/；从源码跑时用仓库根目录的
export const ASSETS_DIR = process.env.WWK_ASSETS
  ?? (existsSync(join(HERE, "assets", "agent.config.json")) ? join(HERE, "assets") : resolve(HERE, "..", "..", "assets"))
export const PROMPTS_DIR = join(ASSETS_DIR, "prompts")
export const DEFAULT_CONFIG = join(ASSETS_DIR, "agent.config.json")
export const DEFAULT_RULES = join(ASSETS_DIR, "rules.yaml")
export const VERIFY_BUNDLE = join(ASSETS_DIR, "verify.mjs")

/** 用户级配置目录：放全局 .env（SMTP、API Key），不随项目走。 */
export function userHome(): string {
  return process.env.WWK_HOME || join(homedir(), ".web-workflow-kit")
}

type Json = Record<string, any>

export const DEFAULTS: Json = JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"))

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

  constructor(raw: Json, projectRoot: string, stateDir: string, env: Record<string, string> = {}) {
    this.raw = raw
    this.projectRoot = projectRoot
    this.stateDir = stateDir
    this.env = env
  }

  get(key: string): Json {
    return this.raw[key] ?? {}
  }

  get maxRetries(): number {
    return Number(this.raw.max_retries)
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
  for (const p of [join(userHome(), ".env"), join(root, ".env")]) {
    if (existsSync(p))
      Object.assign(env, parseEnv(readFileSync(p)))
  }

  const maxRetries = Number(raw.max_retries ?? 3)
  if (!(maxRetries >= 1))
    throw new Error("max_retries must be >= 1")
  raw.max_retries = maxRetries

  const stateDir = resolve(root, raw.state_dir ?? ".agent")
  return new Config(raw, root, stateDir, env)
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
