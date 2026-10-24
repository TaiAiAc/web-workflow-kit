// 控制台的工作空间：用户加过的项目、每个项目选过的 agent，以及落盘的运行记录。
// - 工作空间列表存在用户级目录（~/.web-workflow-kit/workspaces.json），浏览器版和桌面端共用；
// - 运行记录在运行结束时写进项目自己的 .agent/runs/<id>.json，服务重启后仍能看到；
// - 每个工作区可带一份工作流覆盖（workflowOverrides），叠在用户级通用配置上，见 config.ts 的 loadWorkflow；
// - 这里只做文件读写，路径合法性、agent 取值由 server.ts 校验。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parse as parseEnv } from "dotenv"
import {
  knownSecrets, loadConfig, readUserWorkflow, redact, resolveWorkflow, saveUserWorkflow,
  userHome, WORKFLOW_DEFAULTS, workspaceEntries, workspaceKey, workspacesFile, writeJsonAtomic,
} from "../config.ts"

export const PREF_KEYS = ["coding_agent", "fix_agent", "review_backend"] as const
const MAX_SAVED_RUNS = 50 // 每个项目只留最近这么多条运行记录

export interface Workspace {
  path: string
  name: string
  added: number
  prefs: Record<string, string>
  /** 只写和通用配置不同的部分；没有就是完全继承 */
  workflowOverrides?: Record<string, any>
  /** 合并弹窗上次选的目标分支，下次默认选它 */
  lastMergeTarget?: string
}

/** 同一个目录只算一个工作空间：统一成绝对路径、正斜杠。 */
export const normalize = workspaceKey

export function load(): Workspace[] {
  return workspaceEntries() as Workspace[]
}

function save(items: Workspace[]): void {
  writeJsonAtomic(workspacesFile(), items)
}

export function find(path: string): Workspace | undefined {
  const key = normalize(path)
  return load().find(w => w.path === key)
}

function projectName(p: string): string {
  try {
    const name = JSON.parse(readFileSync(join(p, "package.json"), "utf8")).name
    if (typeof name === "string" && name.trim())
      return name.trim()
  }
  catch {}
  return basename(p) || p
}

export function add(path: string): Workspace {
  if (!String(path).trim() || !existsSync(path) || !statSync(path).isDirectory())
    throw new Error(`项目路径不存在或不是目录：${path}`)
  const key = normalize(path)
  const items = load()
  const found = items.find(w => w.path === key)
  if (found)
    return found
  const ws: Workspace = { path: key, name: projectName(key), added: Date.now() / 1000, prefs: {} }
  save([ws, ...items]) // 新加的排最前
  return ws
}

/** 只是从列表里移除，不删项目里的任何文件。 */
export function remove(path: string): void {
  const key = normalize(path)
  save(load().filter(w => w.path !== key))
}

export function setPrefs(path: string, prefs: Record<string, unknown>): Workspace {
  const key = normalize(path)
  const items = load()
  const ws = items.find(w => w.path === key)
  if (!ws)
    throw new Error(`不是已添加的工作空间：${path}`)
  const current = { ...ws.prefs }
  for (const k of PREF_KEYS) {
    if (!(k in prefs))
      continue
    if (prefs[k])
      current[k] = String(prefs[k])
    else
      delete current[k] // 空值 = 回到默认
  }
  ws.prefs = current
  save(items)
  return ws
}

/** 设置工作区的工作流覆盖；和通用配置合并后不合法就不存。空对象 = 完全继承。 */
export function setWorkflowOverrides(path: string, overrides: Record<string, any>): Workspace {
  const items = load()
  const ws = items.find(w => w.path === normalize(path))
  if (!ws)
    throw new Error(`不是已添加的工作空间：${path}`)
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("工作流覆盖必须是对象")
  resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["user", readUserWorkflow()], ["workspace", overrides]])
  if (Object.keys(overrides).length)
    ws.workflowOverrides = overrides
  else
    delete ws.workflowOverrides
  save(items)
  return ws
}

export function setLastMergeTarget(path: string, target: string): void {
  const items = load()
  const ws = items.find(w => w.path === normalize(path))
  if (!ws)
    return // 不是工作空间（比如命令行跑的）就不记
  ws.lastMergeTarget = target
  save(items)
}

/** 项目文件夹搬了家：把原来的工作区（偏好、覆盖）挪到新路径。 */
export function rebind(oldPath: string, newPath: string): Workspace {
  if (!String(newPath).trim() || !existsSync(newPath) || !statSync(newPath).isDirectory())
    throw new Error(`项目路径不存在或不是目录：${newPath}`)
  const items = load()
  const ws = items.find(w => w.path === normalize(oldPath))
  if (!ws)
    throw new Error(`不是已添加的工作空间：${oldPath}`)
  const key = normalize(newPath)
  if (key !== ws.path && items.some(w => w.path === key))
    throw new Error(`新路径已经是一个工作空间：${newPath}`)
  ws.path = key
  save(items)
  return ws
}

// ---------------- 工作流配置导出 / 导入 ----------------

const EXPORT_KIND = "wwk-workflow-export"

/** 通用配置 + 各工作区覆盖；不含密钥（字段名像密钥的、值里含已知密钥的都打码）。 */
export function exportWorkflow(): Record<string, any> {
  const secrets = knownSecrets(loadEnvForRedaction())
  return {
    kind: EXPORT_KIND,
    version: 2,
    exported_at: new Date().toISOString(),
    workflow: redact(readUserWorkflow(), secrets),
    workspaces: load().filter(w => w.workflowOverrides).map(w => ({ path: w.path, workflowOverrides: redact(w.workflowOverrides, secrets) })),
  }
}

/** 导入：先全部校验，再一起写。只覆盖本机已添加的工作区，别的路径跳过（换了电脑路径多半不同）。 */
export function importWorkflow(data: Record<string, any>): { workspaces: string[], skipped: string[] } {
  if (data?.kind !== EXPORT_KIND || data.version !== 2)
    throw new Error("不是 web-workflow-kit 导出的工作流配置（或版本不对）")
  const user = data.workflow && typeof data.workflow === "object" ? data.workflow : {}
  const items = load()
  const applied: [Workspace, Record<string, any>][] = []
  const skipped: string[] = []
  for (const entry of Array.isArray(data.workspaces) ? data.workspaces : []) {
    const ws = items.find(w => w.path === normalize(String(entry?.path ?? "")))
    if (!ws || !entry.workflowOverrides || typeof entry.workflowOverrides !== "object") {
      skipped.push(String(entry?.path ?? ""))
      continue
    }
    resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["user", user], ["workspace", entry.workflowOverrides]])
    applied.push([ws, entry.workflowOverrides])
  }
  resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["user", user]])
  for (const ws of items) { // 没导入覆盖的工作区也要和新的通用配置合得上
    const overrides = applied.find(([a]) => a === ws)?.[1] ?? ws.workflowOverrides
    if (overrides)
      resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["user", user], ["workspace", overrides]])
  }
  for (const [ws, overrides] of applied)
    ws.workflowOverrides = overrides
  save(items)
  saveUserWorkflow(user)
  return { workspaces: applied.map(([ws]) => ws.path), skipped }
}

// 导出时用来认出被抄进配置的密钥：只看用户级 .env，不涉及具体项目
function loadEnvForRedaction(): Record<string, string> {
  try {
    return parseEnv(readFileSync(join(userHome(), ".env")))
  }
  catch {
    return {}
  }
}

/** 读 .git/HEAD，不调 git 命令；分离 HEAD 时给短哈希。 */
export function gitBranch(path: string): string | null {
  try {
    const text = readFileSync(join(path, ".git", "HEAD"), "utf8").trim()
    return text.startsWith("ref:") && text.includes("refs/heads/") ? text.split("refs/heads/")[1] : text.slice(0, 7)
  }
  catch {
    return null
  }
}

// ---------------- 运行记录落盘 ----------------

export function runsDir(projectRoot: string): string {
  let state: string
  try {
    state = loadConfig(projectRoot).stateDir
  }
  catch { // 配置写坏了也不影响看历史
    state = join(projectRoot, ".agent")
  }
  return join(state, "runs")
}

export function saveRun(projectRoot: string, record: Record<string, any>): void {
  const d = runsDir(projectRoot)
  try {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `${record.id}.json`), JSON.stringify(record), "utf8")
    const old = readdirSync(d).filter(f => f.endsWith(".json"))
      .map(f => ({ f, t: statSync(join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(MAX_SAVED_RUNS)
    for (const { f } of old) {
      unlinkSync(join(d, f))
      rmSync(join(d, f.slice(0, -".json".length)), { recursive: true, force: true }) // 该次运行的快照等
    }
  }
  catch {} // 项目目录不可写时只保留内存里的记录
}

/** 项目里落盘的运行记录（只取摘要，不带事件）。 */
export function savedRuns(projectRoot: string): Record<string, any>[] {
  const d = runsDir(projectRoot)
  let files: string[]
  try {
    files = readdirSync(d).filter(f => f.endsWith(".json"))
  }
  catch {
    return []
  }
  const out: Record<string, any>[] = []
  for (const f of files) {
    try {
      const { events: _e, input: _i, result: _r, error: _x, ...brief } = JSON.parse(readFileSync(join(d, f), "utf8"))
      out.push(brief)
    }
    catch {}
  }
  return out.sort((a, b) => (b.started ?? 0) - (a.started ?? 0))
}

export function loadRun(projectRoot: string, runId: string): Record<string, any> | null {
  if (!/^[a-z0-9]+$/i.test(runId))
    return null
  try {
    return JSON.parse(readFileSync(join(runsDir(projectRoot), `${runId}.json`), "utf8"))
  }
  catch {
    return null
  }
}
