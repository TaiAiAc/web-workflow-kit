// 子进程：按 PATH（Windows 上含 PATHEXT）找命令、带超时运行、超时整棵进程树一起结束。
import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import process from "node:process"

const isWin = process.platform === "win32"

/** 等同 Python 的 shutil.which：Windows 上 dsh / claude 是 .cmd，要按 PATHEXT 找。 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = isWin ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""]
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

export function killTree(pid: number | undefined): void {
  if (!pid)
    return
  try {
    if (isWin)
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
    else
      process.kill(-pid, "SIGKILL")
  }
  catch {
    try {
      process.kill(pid, "SIGKILL")
    }
    catch {} // 已经退出
  }
}
