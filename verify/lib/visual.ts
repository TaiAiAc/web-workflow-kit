// 视觉验收：起应用 → 经 Chrome DevTools Protocol 连上渲染进程 → 断言文本/选择器、白屏、未捕获异常 → 截图。
// 纯脚本判定，不调模型；Electron 与 Chromium 系浏览器都讲 CDP，所以同一套代码可用 Edge/Chrome 做测试。
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { killTree, tail } from './util.ts'

export interface VisualRule {
  exe: string
  args?: string[]
  port?: number              // 0 = 让应用自选端口，从 stderr 的 “DevTools listening on” 读
  timeout_ms?: number        // 启动 + 等待断言成立的总时长
  expect_text?: string[]     // 页面可见文本里必须出现
  expect_selector?: string[] // 必须存在的 CSS 选择器
  forbid_text?: string[]     // 不得出现（如 “Error”“加载失败”）
  fail_on_exception?: boolean
  screenshot?: string        // 截图保存路径（绝对路径）
}

export interface VisualIssue {
  code: 'VISUAL_UNAVAILABLE' | 'VISUAL_BLANK' | 'VISUAL_MISSING' | 'VISUAL_FORBIDDEN' | 'RENDERER_ERROR'
  message: string
  detail?: string
}

interface PageState { text: string, elements: number, missing: string[] }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class CDP {
  private seq = 0
  private pending = new Map<number, (msg: any) => void>()
  readonly exceptions: string[] = []
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg)
        this.pending.delete(msg.id)
      }
      else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.exceptions.push(d.exception?.description ?? d.text ?? 'exception')
      }
    })
  }

  static open(url: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new CDP(ws)))
      ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)))
    })
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, msg => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.ws.close()
  }
}

function userDataDir(args: string[]): string | undefined {
  const a = args.find(x => x.startsWith('--user-data-dir='))
  return a?.slice('--user-data-dir='.length).replace(/^"|"$/g, '')
}

// 端口来源有两种：Electron/Chrome 打到 stderr；Edge 等会转交给后台进程、只写 <user-data-dir>/DevToolsActivePort
function readPort(stderr: string, dataDir: string | undefined): number | undefined {
  const m = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//)
  if (m)
    return Number(m[1])
  if (dataDir) {
    try {
      const port = Number(readFileSync(join(dataDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])
      if (port > 0)
        return port
    }
    catch {}
  }
  return undefined
}

async function waitForDevtoolsPort(stderr: () => string, args: string[], fixed: number, deadline: number,
  crashed: () => string | null): Promise<number> {
  if (fixed > 0)
    return fixed
  const dataDir = userDataDir(args)
  while (Date.now() < deadline) {
    const port = readPort(stderr(), dataDir)
    if (port)
      return port
    const why = crashed()
    if (why)
      throw new Error(`app exited (${why})`)
    await sleep(100)
  }
  throw new Error('no DevTools port: app never printed "DevTools listening on" (remote debugging disabled?)')
}

// 用 CDP 关整个应用：转交给后台进程的浏览器 killTree 杀不到
async function closeBrowser(port: number) {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any
    const browser = await CDP.open(webSocketDebuggerUrl)
    await Promise.race([browser.send('Browser.close'), sleep(2000)])
    browser.close()
  }
  catch {}
}

async function findPage(port: number, deadline: number): Promise<string> {
  let last = ''
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[]
      const page = targets.find(t => t.type === 'page' && !String(t.url).startsWith('devtools://'))
      if (page?.webSocketDebuggerUrl)
        return page.webSocketDebuggerUrl
      last = `targets: ${targets.map(t => `${t.type}:${t.url}`).join(', ') || 'none'}`
    }
    catch (e) {
      last = (e as Error).message
    }
    await sleep(200)
  }
  throw new Error(`no renderer page appeared on port ${port} (${last})`)
}

const PROBE = (selectors: string[]) => `(() => {
  const sel = ${JSON.stringify(selectors)};
  return JSON.stringify({
    text: document.body ? document.body.innerText : '',
    elements: document.body ? document.body.querySelectorAll('*').length : 0,
    missing: sel.filter(s => !document.querySelector(s)),
  });
})()`

async function probe(cdp: CDP, selectors: string[]): Promise<PageState> {
  const r = await cdp.send('Runtime.evaluate', { expression: PROBE(selectors), returnByValue: true })
  return JSON.parse(r.result.value)
}

export async function runVisual(rule: VisualRule, cwd: string, maxDetail: number): Promise<VisualIssue[]> {
  const timeout = rule.timeout_ms ?? 15000
  const deadline = Date.now() + timeout
  const port = rule.port ?? 0
  const errChunks: Buffer[] = []
  const args = [`--remote-debugging-port=${port}`, ...(rule.args ?? [])]
  const dataDir = userDataDir(args)
  if (dataDir)
    rmSync(join(dataDir, 'DevToolsActivePort'), { force: true }) // 上次运行残留的端口文件会指向死端口
  const child = spawn(rule.exe, args, {
    cwd,
    detached: process.platform !== 'win32',
  })
  child.stderr?.on('data', (d: Buffer) => errChunks.push(d))
  child.stdout?.on('data', () => {})
  // 退出码 0 可能只是启动器把活交给了后台进程；非 0 或启动失败才算崩
  let crashed: string | null = null
  child.on('exit', (code, signal) => {
    if (code !== 0)
      crashed = `code=${code}, signal=${signal}`
  })
  child.on('error', (e) => { crashed = e.message })
  const stderr = () => Buffer.concat(errChunks).toString('utf8')

  let cdp: CDP | undefined
  let devtoolsPort: number | undefined
  try {
    try {
      devtoolsPort = await waitForDevtoolsPort(stderr, args, port, deadline, () => crashed)
      cdp = await CDP.open(await findPage(devtoolsPort, deadline))
    }
    catch (e) {
      return [{ code: 'VISUAL_UNAVAILABLE', message: (e as Error).message, detail: tail(stderr(), maxDetail) }]
    }

    await cdp.send('Runtime.enable')
    await sleep(300) // 让已排队的 exceptionThrown 事件先到
    const want = rule.expect_text ?? []
    const selectors = rule.expect_selector ?? []
    let state: PageState = { text: '', elements: 0, missing: selectors }
    // 断言在截止前任一时刻成立即可：页面可能异步渲染
    while (true) {
      state = await probe(cdp, selectors)
      const ok = want.every(t => state.text.includes(t)) && state.missing.length === 0 && state.elements > 0
      if (ok || Date.now() > deadline)
        break
      await sleep(250)
    }

    const issues: VisualIssue[] = []
    if (state.elements === 0 && !state.text.trim()) {
      issues.push({ code: 'VISUAL_BLANK', message: 'renderer page is blank (no elements in <body>)' })
    }
    else {
      for (const t of want.filter(t => !state.text.includes(t)))
        issues.push({ code: 'VISUAL_MISSING', message: `text not visible within ${timeout}ms: ${JSON.stringify(t)}` })
      for (const s of state.missing)
        issues.push({ code: 'VISUAL_MISSING', message: `selector not found within ${timeout}ms: ${s}` })
    }
    for (const t of (rule.forbid_text ?? []).filter(t => state.text.includes(t)))
      issues.push({ code: 'VISUAL_FORBIDDEN', message: `forbidden text visible: ${JSON.stringify(t)}` })
    if (rule.fail_on_exception !== false && cdp.exceptions.length) {
      issues.push({
        code: 'RENDERER_ERROR',
        message: `${cdp.exceptions.length} uncaught exception(s) in renderer`,
        detail: tail(cdp.exceptions.join('\n---\n'), maxDetail),
      })
    }
    if (issues.length)
      issues[0].detail ??= tail(`visible text:\n${state.text}`, maxDetail)

    if (rule.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      mkdirSync(dirname(rule.screenshot), { recursive: true })
      writeFileSync(rule.screenshot, Buffer.from(shot.data, 'base64'))
    }
    return issues
  }
  finally {
    cdp?.close()
    if (devtoolsPort)
      await closeBrowser(devtoolsPort)
    killTree(child.pid)
  }
}
