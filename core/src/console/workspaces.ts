// 控制台的工作空间：用户加过的项目、每个项目选过的 agent，以及落盘的运行记录。
// - 工作空间列表存在用户级目录（~/.web-workflow-kit/workspaces.json），浏览器版和桌面端共用；
// - 运行记录在运行结束时写进项目自己的 .agent/runs/<id>.json，服务重启后仍能看到；
// - 这里只做文件读写，路径合法性、agent 取值由 server.ts 校验。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { loadConfig, userHome } from "../config.ts"

export const PREF_KEYS = ["coding_agent", "fix_agent", "review_backend"] as const
const MAX_SAVED_RUNS = 50 // 每个项目只留最近这么多条运行记录

export interface Workspace {
  path: string
  name: string
  added: number
  prefs: Record<string, string>
}

const file = () => join(userHome(), "workspaces.json")

/** 同一个目录只算一个工作空间：统一成绝对路径、正斜杠。 */
export function normalize(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const p = path.startsWith("~") ? home + path.slice(1) : path
  return resolve(p).replaceAll("\\", "/").replace(/(.)\/+$/, "$1")
}

export function load(): Workspace[] {
  try {
    const data = JSON.parse(readFileSync(file(), "utf8"))
    return Array.isArray(data) ? data.filter(w => w && typeof w === "object" && w.path) : []
  }
  catch {
    return []
  }
}

function save(items: Workspace[]): void {
  const f = file()
  mkdirSync(userHome(), { recursive: true })
  writeFileSync(`${f}.tmp`, JSON.stringify(items, null, 2), "utf8")
  renameSync(`${f}.tmp`, f)
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
    for (const { f } of old)
      unlinkSync(join(d, f))
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
