import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import process from 'node:process'
import { assetsDir, coreBundle } from './env'

// 固定端口：页面把主题、草稿、最近项目存在 localStorage 里，端口一变就丢了
const PREFERRED_PORTS = [18765, 18766, 18767, 18768, 18769]
const START_TIMEOUT = 60_000
const LOG_LINES = 200
const LINE_BREAK = /\r?\n/
const WHITESPACE = /\s+/
const SERVER_URL = /http:\/\/127\.0\.0\.1:\d+\//

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer()
    srv.once('error', () => resolvePromise(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolvePromise(true)))
  })
}

async function pickPort(): Promise<number> {
  for (const port of PREFERRED_PORTS) {
    if (await portFree(port))
      return port
  }
  return 0 // 都被占用时交给系统分配
}

/**
 * 列出 pid 的全部子孙进程。门禁给每条检查命令开了独立进程组（超时好整组杀），
 * 按进程组杀够不着它们；后端一退出它们又会被 launchd 收养，所以要先把整棵树记下来再杀。
 */
function descendants(pid: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' })
  const children = new Map<number, number[]>()
  for (const line of (r.stdout || '').split(LINE_BREAK)) {
    const [p, pp] = line.trim().split(WHITESPACE).map(Number)
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

function signal(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig)
    }
    catch {} // 已经退出
  }
}

export class Backend {
  private child?: ChildProcess
  private stopping = false
  readonly log: string[] = []
  url = ''

  /** 后端意外退出时回调（主动 stop 不触发） */
  onExit?: (code: number | null) => void

  private push(text: string): void {
    for (const line of text.split(LINE_BREAK)) {
      if (line.trim())
        this.log.push(line)
    }
    if (this.log.length > LOG_LINES)
      this.log.splice(0, this.log.length - LOG_LINES)
  }

  tail(n = 40): string {
    return this.log.slice(-n).join('\n')
  }

  /** 用 Electron 自带的 Node 启动 TS 核心的 `wwk ui`，等它打印出地址后返回 */
  async start(): Promise<string> {
    await this.stop()
    this.stopping = false
    this.log.length = 0
    const port = await pickPort()
    const args = [coreBundle(), 'ui', '--port', String(port), '--no-browser']
    // cwd 放在用户目录：门禁和 agent 都按页面上填的项目路径工作，不依赖这里
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WWK_ASSETS: assetsDir() }
    const child = spawn(process.execPath, args, { env, cwd: homedir(), windowsHide: true })
    this.child = child

    return new Promise<string>((resolvePromise, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const fail = (msg: string) => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        void this.stop()
        reject(new Error(msg))
      }
      timer = setTimeout(fail, START_TIMEOUT, `本地服务 ${START_TIMEOUT / 1000} 秒内没有启动`)

      const onData = (d: Buffer) => {
        const text = d.toString('utf-8')
        this.push(text)
        const m = text.match(SERVER_URL)
        if (m && !settled) {
          settled = true
          clearTimeout(timer)
          this.url = m[0]
          resolvePromise(this.url)
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', e => fail(`无法启动本地服务：${e.message}`))
      child.on('exit', (code) => {
        if (this.child === child)
          this.child = undefined
        if (!settled)
          return fail(`本地服务启动失败（退出码 ${code}）`)
        if (!this.stopping)
          this.onExit?.(code)
      })
    })
  }

  /** 结束后端及其子进程（门禁命令、编程 agent 都是它拉起的） */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null)
      return
    this.stopping = true
    this.child = undefined
    this.url = ''
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    }
    const tree = child.pid ? descendants(child.pid) : []
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      child.kill('SIGTERM')
      signal(tree, 'SIGTERM')
    })
    // 子孙和后端一起收到 SIGTERM，后端退出后再稍等片刻，还在的强杀（这期间 pid 被复用的概率可以忽略）
    if (tree.length)
      await new Promise(r => setTimeout(r, 300))
    signal(tree, 'SIGKILL')
  }
}
