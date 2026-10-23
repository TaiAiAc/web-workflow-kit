import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { app } from 'electron'

/** 一个可执行的 Python：命令 + 前置参数（`py -3` 这类启动器需要） */
export interface PythonCommand {
  command: string
  args: string[]
  label: string
}

export interface ProbeFailure {
  label: string
  error: string
}

const isWin = process.platform === 'win32'
const LINE_BREAK = /\r?\n/
const MISSING_DEPS = /No module named '(?:langgraph|dotenv)'/

// 后端只需要这几个模块；web_workflow_kit 由 PYTHONPATH 指向随应用分发的源码
const PROBE = [
  'import sys',
  'assert sys.version_info >= (3, 10), "需要 Python 3.10 及以上，当前为 " + sys.version.split()[0]',
  'import langgraph, dotenv',
  'import web_workflow_kit.ui.server',
  'print(sys.executable)',
].join('\n')

/** web_workflow_kit 包所在目录：打包后在 resources/python，开发时是仓库根目录 */
export function packageRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'python')
    : resolve(__dirname, '../../..')
}

export function pythonEnv(): NodeJS.ProcessEnv {
  const root = packageRoot()
  return {
    ...process.env,
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(isWin ? ';' : ':'),
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  }
}

// ---------- 用户选择的解释器，存在 userData/settings.json ----------

interface Settings {
  pythonPath?: string
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf-8')) as Settings
  }
  catch {
    return {}
  }
}

export function saveSettings(patch: Settings): void {
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...readSettings(), ...patch }, null, 2), 'utf-8')
}

// ---------- 查找 ----------

function venvPython(dir: string): string {
  return isWin ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python')
}

/** 按优先级列出候选：用户选的 → WWK_PYTHON → README 推荐的 ~/wwk-venv → 仓库 .venv（开发）→ PATH */
export function candidates(): PythonCommand[] {
  const list: PythonCommand[] = []
  const add = (command: string | undefined, label: string, args: string[] = []) => {
    if (command && !list.some(c => c.command === command && c.args.join() === args.join()))
      list.push({ command, args, label })
  }
  const file = (path: string | undefined, label: string) => {
    if (path && existsSync(path))
      add(path, `${label}（${path}）`)
  }

  file(readSettings().pythonPath, '已选择的解释器')
  file(process.env.WWK_PYTHON, '环境变量 WWK_PYTHON')
  file(venvPython(join(homedir(), 'wwk-venv')), '~/wwk-venv')
  if (!app.isPackaged)
    file(venvPython(join(packageRoot(), '.venv')), '仓库 .venv')
  if (isWin)
    add('py', 'py -3', ['-3'])
  add(isWin ? 'python' : 'python3', isWin ? 'PATH 中的 python' : 'PATH 中的 python3')
  return list
}

function run(py: PythonCommand, args: string[], timeoutMs: number): Promise<{ code: number | null, out: string, err: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(py.command, [...py.args, ...args], { env: pythonEnv(), windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      err += `\n超过 ${timeoutMs / 1000} 秒没有响应`
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf-8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolvePromise({ code: null, out, err: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, out, err })
    })
  })
}

/** 取 Python 报错的最后一行，比如 `ModuleNotFoundError: No module named 'langgraph'` */
function lastLine(text: string): string {
  return text.trim().split(LINE_BREAK).filter(Boolean).pop() ?? ''
}

export async function probe(py: PythonCommand): Promise<string | null> {
  const r = await run(py, ['-c', PROBE], 30_000)
  if (r.code === 0)
    return null
  if (r.code === null)
    return `无法运行：${r.err}`
  // Windows 上没装 Python 时，PATH 里的 python 是应用商店的占位程序，退出码 9009
  if (isWin && r.code === 9009)
    return '没有安装（只有 Microsoft Store 的占位程序）'
  const msg = lastLine(r.err) || lastLine(r.out) || `退出码 ${r.code}`
  if (MISSING_DEPS.test(msg))
    return `${msg}（这个 Python 还没装 web-workflow-kit 的依赖）`
  return msg
}

/** 返回第一个能跑后端的解释器；都不行时返回每个候选的失败原因 */
export async function findPython(onTry?: (py: PythonCommand) => void): Promise<{ python?: PythonCommand, failures: ProbeFailure[] }> {
  const failures: ProbeFailure[] = []
  for (const py of candidates()) {
    onTry?.(py)
    const error = await probe(py)
    if (!error)
      return { python: py, failures }
    failures.push({ label: py.label, error })
  }
  return { failures }
}
