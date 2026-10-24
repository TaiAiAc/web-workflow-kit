// 预览：运行结束后一键把项目跑起来（开发服务器），页面上看状态、点地址，随时停止。
// - 跑哪份代码：待合并 / 待处理的运行在项目外的临时目录检出作业分支、装依赖后启动；已合并或没有作业分支的直接在项目里启动；
// - 怎么启动：agent.config.json 的 preview.command > package.json 的 dev / start / serve / preview 脚本 > 问编程 agent（只读）；
// - 开发服务器要一直跑着，所以进程由控制台托管：同一个项目同时只有一个预览，控制台退出时一并结束。
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { END_TURN } from "../agents.ts"
import type { Config } from "../config.ts"
import { git, installCommandFor, installDeps, readManifest, worktreeDir } from "../gitflow.ts"
import { killTree } from "../proc.ts"
import { buildRoleAgent } from "../stages.ts"
import * as W from "./workspaces.ts"

type Json = Record<string, any>

export type PreviewStatus = "preparing" | "installing" | "starting" | "running" | "exited" | "failed" | "stopped"

export interface Preview {
  project: string
  runId: string | null
  status: PreviewStatus
  /** 跑的是哪份代码，给人看 */
  source: string
  command: string | null
  /** 命令从哪来：配置 / package.json 脚本 / agent */
  via: string | null
  cwd: string | null
  url: string | null
  log: string[]
  started: number
  exitCode: number | null
  error: string | null
}

interface Entry extends Preview {
  child?: ChildProcess
  worktree?: string
}

const previews = new Map<string, Entry>()
const isWin = process.platform === "win32"
const MAX_LOG = 300
// 开发服务器打印的本机地址（vite / webpack / next / nuxt / uni……），去掉颜色码后找
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s'"`\\]*)?/
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g // eslint-disable-line no-control-regex

const publicView = (e: Entry): Preview => {
  const { child: _c, worktree: _w, ...rest } = e
  return { ...rest, log: rest.log.slice(-80) }
}

export function getPreview(project: string): Preview | null {
  const e = previews.get(W.normalize(project))
  return e ? publicView(e) : null
}

/** 停掉项目的预览（进程树一起结束，临时目录清掉）。 */
export function stopPreview(project: string): Preview | null {
  const e = previews.get(W.normalize(project))
  if (!e)
    return null
  if (e.child && e.child.exitCode === null && !["exited", "failed", "stopped"].includes(e.status)) {
    e.status = "stopped"
    killTree(e.child.pid)
  }
  else if (e.status !== "exited" && e.status !== "failed") {
    e.status = "stopped" // 还在准备阶段：准备完发现已停止就不再启动
  }
  return publicView(e)
}

/** 控制台退出时调用 */
export function stopAllPreviews(): void {
  for (const project of previews.keys())
    stopPreview(project)
}

function needsInstall(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    return Object.keys(deps).length > 0 && !existsSync(join(dir, "node_modules"))
  }
  catch {
    return false
  }
}

/** 包管理器跑 package.json 里的脚本 */
function scriptCommand(dir: string): string | null {
  let pkg: Json
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  }
  catch {
    return null
  }
  const script = ["dev", "start", "serve", "preview"].find(s => typeof pkg.scripts?.[s] === "string")
  if (!script)
    return null
  const install = installCommandFor(dir)?.[0] ?? "npm"
  return `${install} run ${script}`
}

/** 没有现成脚本时问编程 agent（只读）：怎么在本地启动开发预览 */
async function askAgent(cfg: Config, dir: string, agentKey: string | null, log: (l: string) => void): Promise<string | null> {
  const { agent, name } = buildRoleAgent(cfg, "dev", agentKey)
  log(`[预览] 没有现成的启动脚本，问 ${name} 怎么跑起来…`)
  const r = await agent.run("这是一个前端项目。请阅读仓库，判断在本地启动**开发预览**（能在浏览器里打开看效果）的命令。"
    + "不要修改任何文件，不要运行命令。只输出一个 JSON 对象，例如 {\"command\": \"npm run dev\"}；实在跑不起来就输出 {\"command\": null, \"reason\": \"原因\"}。", dir)
  if (r.stopReason !== END_TURN)
    return null
  const m = /\{[^{}]*"command"[^{}]*\}/.exec(r.text)
  try {
    const obj = m ? JSON.parse(m[0]) : null
    if (typeof obj?.command === "string" && obj.command.trim())
      return obj.command.trim()
    log(`[预览] ${name} 认为跑不起来：${obj?.reason ?? r.text.slice(-200)}`)
  }
  catch {}
  return null
}

export interface StartOptions {
  /** 问哪个编程 agent 怎么启动（默认工作流配置的 dev 角色） */
  agent?: string | null
  /** 测试用：替换「问 agent」 */
  ask?: (dir: string) => Promise<string | null>
}

/** 开始预览；同一个项目已有预览就先停掉。准备和启动在后台进行，页面轮询 getPreview。 */
export function startPreview(cfg: Config, runId: string | null, opts: StartOptions = {}): Preview {
  const project = W.normalize(cfg.projectRoot)
  stopPreview(project)
  const old = previews.get(project)
  if (old?.worktree)
    cleanup(cfg, old)
  const e: Entry = {
    project, runId, status: "preparing", source: "项目目录", command: null, via: null, cwd: null, url: null,
    log: [], started: Date.now() / 1000, exitCode: null, error: null,
  }
  previews.set(project, e)
  void prepare(cfg, e, opts).catch((err) => {
    e.status = "failed"
    e.error = (err as Error).message
    push(e, `[预览] ${e.error}`)
    cleanup(cfg, e)
  })
  return publicView(e)
}

function push(e: Entry, line: string): void {
  e.log.push(line)
  if (e.log.length > MAX_LOG)
    e.log.splice(0, e.log.length - MAX_LOG)
}

function cleanup(cfg: Config, e: Entry): void {
  if (!e.worktree)
    return
  git(cfg.projectRoot, ["worktree", "remove", "--force", e.worktree], { allowFail: true })
  try {
    rmSync(e.worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  catch {}
  git(cfg.projectRoot, ["worktree", "prune"], { allowFail: true })
  e.worktree = undefined
}

async function prepare(cfg: Config, e: Entry, opts: StartOptions): Promise<void> {
  const log = (l: string) => push(e, l)
  const stopped = () => e.status === "stopped"
  let dir = cfg.projectRoot
  // 待合并 / 待处理：交付的代码在作业分支上，检出到项目外的临时目录再跑，不动项目本身
  const m = e.runId ? readManifest(cfg.stateDir, e.runId) : null
  if (m && (m.status === "ready_to_merge" || m.status === "held")) {
    const wt = worktreeDir(cfg.projectRoot, `preview-${m.run_id}`)
    rmSync(wt, { recursive: true, force: true })
    git(cfg.projectRoot, ["worktree", "prune"], { allowFail: true })
    git(cfg.projectRoot, ["worktree", "add", "-q", "--detach", wt, m.work.branch])
    e.worktree = wt
    e.source = `作业分支 ${m.work.branch}（临时目录）`
    dir = wt
    e.status = "installing"
    const failed = await installDeps(wt, { installCommand: cfg.workflow.raw.stages?.gate?.install_command ?? "auto", env: cfg.childEnv(), timeoutMs: Number(cfg.get("verify").timeout_sec ?? 3600) * 1000 }, log)
    if (failed)
      throw new Error(failed)
  }
  else {
    e.source = m?.status === "merged" ? `项目目录（已合并到 ${m.merge?.target}）` : "项目目录"
    if (needsInstall(dir)) { // 只在声明了依赖却没装时才装，免得在项目里平白生成锁文件
      e.status = "installing"
      const failed = await installDeps(dir, { installCommand: "auto", env: cfg.childEnv() }, log)
      if (failed)
        throw new Error(failed)
    }
  }
  if (stopped())
    return cleanup(cfg, e)

  // 启动命令：配置 > 脚本 > agent
  let command: string | null = cfg.get("preview").command ?? null
  e.via = command ? "agent.config.json 的 preview.command" : null
  if (!command && (command = scriptCommand(dir)))
    e.via = "package.json 脚本"
  if (!command) {
    command = opts.ask ? await opts.ask(dir) : await askAgent(cfg, dir, opts.agent ?? null, log)
    e.via = command ? "agent 判断" : null
  }
  if (!command)
    throw new Error("找不到启动方式：package.json 没有 dev / start / serve / preview 脚本，agent 也没给出命令。可以在 agent.config.json 里设 preview.command")
  if (stopped())
    return cleanup(cfg, e)

  e.command = command
  e.cwd = dir
  e.status = "starting"
  log(`[预览] ${command}（${e.via}）`)
  const [cmd, args] = isWin ? ["cmd", ["/d", "/s", "/c", `"${command}"`]] : ["sh", ["-c", command]]
  const child = spawn(cmd, args, {
    cwd: dir,
    // BROWSER=none：别让 create-react-app 之类自己弹浏览器；颜色码关掉好找地址
    env: { ...cfg.childEnv(), BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1" },
    detached: !isWin,
    windowsHide: true,
    windowsVerbatimArguments: isWin,
    stdio: ["ignore", "pipe", "pipe"],
  })
  e.child = child
  let pending = ""
  const feed = (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const raw of lines) {
      const line = raw.replace(ANSI_RE, "").trimEnd()
      if (!line.trim())
        continue
      push(e, line)
      // npm / pnpm 先把要执行的命令回显成「> 命令」，命令里的地址不算服务器打印的
      const url = !e.url && !line.trimStart().startsWith(">") && URL_RE.exec(line)?.[0]
      if (url) {
        e.url = url.replace("0.0.0.0", "localhost").replace(/[).,]+$/, "")
        if (e.status === "starting")
          e.status = "running"
      }
    }
  }
  child.stdout!.setEncoding("utf8").on("data", feed)
  child.stderr!.setEncoding("utf8").on("data", feed)
  child.on("error", (err) => {
    e.status = "failed"
    e.error = err.message
  })
  child.on("exit", (code) => {
    e.exitCode = code
    if (e.status !== "stopped")
      e.status = e.url ? "exited" : "failed"
    if (e.status === "failed" && !e.error)
      e.error = `进程退出（退出码 ${code}），没有打印出访问地址`
    cleanup(cfg, e)
  })
}
