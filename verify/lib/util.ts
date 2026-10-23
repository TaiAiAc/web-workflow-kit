import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface CommandResult {
  code: number | null
  timedOut: boolean
  output: string
  durationMs: number
}

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

// 只保留尾部：错误信息几乎总在最后
export function tail(s: string, max: number): string {
  if (s.length <= max)
    return s
  return `…(${s.length - max} chars truncated)\n${s.slice(-max)}`
}

export function killTree(pid: number | undefined): void {
  if (!pid)
    return
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else
    try { process.kill(-pid, 'SIGKILL') }
    catch { try { process.kill(pid, 'SIGKILL') } catch {} }
}

export function runCommand(cmd: string, cwd: string, timeoutSec: number): Promise<CommandResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => chunks.push(d))
    child.stderr?.on('data', (d: Buffer) => chunks.push(d))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutSec * 1000)
    const done = (code: number | null) => {
      clearTimeout(timer)
      resolve({
        code,
        timedOut,
        output: stripAnsi(Buffer.concat(chunks).toString('utf8')),
        durationMs: Date.now() - start,
      })
    }
    child.on('error', (e) => {
      chunks.push(Buffer.from(String(e)))
      done(null)
    })
    child.on('close', done)
  })
}

// 从 tsc / vue-tsc / eslint / vitest 输出里抽取源码位置，给修复 agent 定位用
const LOC = /((?:[A-Za-z]:)?[\w@./\\-]+\.(?:vue|tsx?|jsx?|mjs|cjs|mts|cts|scss|css|json))(?:[:(](\d+)(?:[:,](\d+))?)/g

export function extractLocations(output: string, limit = 20): string[] {
  const seen = new Set<string>()
  for (const m of output.matchAll(LOC)) {
    if (m[1].includes('node_modules'))
      continue
    const loc = m[2] ? `${m[1].replace(/\\/g, '/')}:${m[2]}${m[3] ? `:${m[3]}` : ''}` : m[1]
    seen.add(loc)
    if (seen.size >= limit)
      break
  }
  return [...seen]
}

// 只支持 * （不跨目录）和 **（跨目录）
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  const p = pattern.replace(/\\/g, '/')
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') {
      re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += p[i + 2] === '/' ? 2 : 1
    }
    else if (c === '*') {
      re += '[^/]*'
    }
    else if (c === '?') {
      re += '[^/]'
    }
    else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

export function walkFiles(dir: string, maxDepth = 8): string[] {
  const out: string[] = []
  const visit = (d: string, depth: number) => {
    if (depth > maxDepth)
      return
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name)
      if (ent.isDirectory())
        visit(full, depth + 1)
      else
        out.push(relative(dir, full).replace(/\\/g, '/'))
    }
  }
  visit(dir, 0)
  return out
}

export function dirSizeBytes(dir: string, exclude: (rel: string) => boolean = () => false): number {
  let total = 0
  for (const rel of walkFiles(dir, 32)) {
    if (!exclude(rel))
      total += statSync(join(dir, rel)).size
  }
  return total
}

export function hashFile(path: string, algo: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash(algo)
    createReadStream(path)
      .on('data', d => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest(encoding)))
  })
}
