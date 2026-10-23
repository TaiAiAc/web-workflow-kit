import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { PythonCommand } from './python'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import process from 'node:process'
import { pythonEnv } from './python'

// 固定端口：页面把主题、草稿、最近项目存在 localStorage 里，端口一变就丢了
const PREFERRED_PORTS = [18765, 18766, 18767, 18768, 18769]
const START_TIMEOUT = 60_000
const LOG_LINES = 200
const LINE_BREAK = /\r?\n/
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

  /** 启动 `web_workflow_kit.cli ui`，等它打印出地址后返回 */
  async start(py: PythonCommand): Promise<string> {
    await this.stop()
    this.stopping = false
    this.log.length = 0
    const port = await pickPort()
    const args = [...py.args, '-m', 'web_workflow_kit.cli', 'ui', '--port', String(port), '--no-browser']
    // cwd 放在用户目录：门禁和 agent 都按页面上填的项目路径工作，不依赖这里
    const child = spawn(py.command, args, { env: pythonEnv(), cwd: homedir(), windowsHide: true })
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
      child.on('error', e => fail(`无法启动 Python：${e.message}`))
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
    })
  }
}
