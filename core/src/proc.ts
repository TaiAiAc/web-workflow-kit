// 子进程：按 PATH（Windows 上含 PATHEXT）找命令、带超时运行、超时整棵进程树一起结束。
import { spawn, spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import process from "node:process"

const isWin = process.platform === "win32"

/** 按 PATH 找命令：Windows 上 dsh / claude 是 .cmd，要按 PATHEXT 找。 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathext = isWin ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : []
  // 已带扩展名（node.exe）或不是 Windows 时先按原名找，再试 PATHEXT 里的扩展名
  const hasExt = pathext.some(e => cmd.toLowerCase().endsWith(e.toLowerCase()))
  const exts = isWin ? [...(hasExt ? [""] : []), ...pathext] : [""]
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile()
  if (/[\\/]/.test(cmd))
    return exts.map(e => cmd + e).find(isFile) ?? null
  for (const dir of (env.PATH || env.Path || "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext)
      if (isFile(p))
        return p
    }
  }
  return null
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunOptions {
  cwd: string
  input?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** 逐行回调 stdout+stderr（门禁靠它实时显示每项检查）；给了就不再缓存输出 */
  onLine?: (line: string) => void
  /** Windows 上参数原样传（cmd /s /c 要自己处理引号，Node 的转义它不认） */
  windowsVerbatimArguments?: boolean
}

/** 运行命令；Windows 的 .cmd / .bat 要经 shell 才能跑。 */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const shell = isWin && /\.(cmd|bat)$/i.test(cmd)
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell,
      windowsHide: true,
      detached: !isWin, // 独立进程组：超时时连同它拉起的子进程一起结束
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.windowsVerbatimArguments,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let pending = ""
    const feed = (chunk: string, isErr: boolean) => {
      if (!opts.onLine) {
        if (isErr)
          stderr += chunk
        else
          stdout += chunk
        return
      }
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      lines.filter(l => l.trim()).forEach(opts.onLine)
    }
    child.stdout.setEncoding("utf8").on("data", (d: string) => feed(d, false))
    child.stderr.setEncoding("utf8").on("data", (d: string) => feed(d, true))
    child.stdin.on("error", () => {}) // 子进程不读 stdin 就退出时，写入会 EPIPE
    child.stdin.end(opts.input ?? "")

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killTree(child.pid)
        }, opts.timeoutMs)
      : undefined
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr + e.message, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (pending.trim() && opts.onLine)
        opts.onLine(pending)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/**
 * 进程的全部子孙，按父进程号找、不管进程组：包管理器跑脚本时会把真正的服务放进新的进程组，
 * 只按组结束会漏掉它（变成挂在 1 号进程下的孤儿）。要在发信号之前取，父进程一退出子孙就被过继走了。
 */
export function descendants(pid: number): number[] {
  if (isWin)
    return []
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
  const children = new Map<number, number[]>()
  for (const line of (r.stdout || "").split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number)
    if (p && pp)
      children.set(pp, [...(children.get(pp) ?? []), p])
  }
  const out: number[] = []
  const queue = [pid]
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      out.push(c)
      queue.push(c)
    }
  }
  return out
}

function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(p, sig)
    }
    catch {} // 已经退出
  }
}

/** 立即结束整棵进程树（超时用）：进程组 + 按父子关系找到的全部子孙；Windows 用 taskkill /T。 */
export function killTree(pid: number | undefined): void {
  if (!pid)
    return
  if (isWin) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
    return
  }
  const tree = descendants(pid)
  try {
    process.kill(-pid, "SIGKILL")
  }
  catch {}
  signalAll([pid, ...tree], "SIGKILL")
}

/** 体面地结束整棵进程树（停止开发服务器用）：先 SIGTERM 让它收尾，graceMs 后还在的 SIGKILL。 */
export function terminateTree(pid: number | undefined, graceMs = 1500): void {
  if (!pid)
    return
  if (isWin) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
    return
  }
  const tree = [pid, ...descendants(pid)]
  try {
    process.kill(-pid, "SIGTERM")
  }
  catch {}
  signalAll(tree, "SIGTERM")
  setTimeout(() => signalAll(tree, "SIGKILL"), graceMs).unref()
}
