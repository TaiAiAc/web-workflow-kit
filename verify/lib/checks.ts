import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import YAML from 'yaml'
import { openAsar } from './asar.ts'
import { runVisual } from './visual.ts'
import {
  dirSizeBytes,
  extractLocations,
  globToRegExp,
  hashFile,
  killTree,
  runCommand,
  tail,
  walkFiles,
} from './util.ts'

export type ProjectType = 'electron' | 'web' | 'uniapp' | 'miniprogram'
export const PROJECT_TYPES: ProjectType[] = ['electron', 'web', 'uniapp', 'miniprogram']

// 失败码是下游（审阅/修复/邮件去重）的唯一契约，新增请同步 prompts/review-prompt.md
export type FailureCode =
  | 'TYPECHECK_FAIL'
  | 'LINT_FAIL'
  | 'TEST_FAIL'
  | 'BUILD_FAIL'
  | 'CHECK_TIMEOUT'
  | 'ARTIFACT_MISSING'
  | 'ASAR_MISSING_ENTRY'
  | 'VERSION_MISMATCH'
  | 'HASH_MISMATCH'
  | 'PACKAGE_TOO_LARGE'
  | 'SMOKE_CRASH'
  | 'VISUAL_UNAVAILABLE'
  | 'VISUAL_BLANK'
  | 'VISUAL_MISSING'
  | 'VISUAL_FORBIDDEN'
  | 'RENDERER_ERROR'
  | 'CONFIG_ERROR'
  | (string & {})

export interface Failure {
  code: FailureCode
  check: string
  message: string
  locations?: string[]
  detail?: string
}

export interface CheckResult {
  id: string
  status: 'pass' | 'fail' | 'skip'
  duration_ms: number
  reason?: string
  failures: Failure[]
}

export interface Defaults {
  timeout_sec: number
  max_detail_chars: number
  fail_fast: boolean
}

export interface Context {
  root: string
  type: ProjectType
  defaults: Defaults
  rule: Record<string, any>
}

export class ConfigError extends Error {}

const COMMAND_CODES: Record<string, FailureCode> = {
  typecheck: 'TYPECHECK_FAIL',
  lint: 'LINT_FAIL',
  test: 'TEST_FAIL',
  build: 'BUILD_FAIL',
}

// 依赖构建产物的检查：build 失败时直接跳过，不制造噪声失败项
export const ARTIFACT_CHECKS = new Set(['artifacts', 'package_size', 'unpacked', 'installer', 'smoke', 'visual'])

const p = (ctx: Context, rel: string) => (isAbsolute(rel) ? rel : resolve(ctx.root, rel))

function readProjectVersion(root: string): string | undefined {
  const pkg = join(root, 'package.json')
  if (!existsSync(pkg))
    return undefined
  return JSON.parse(readFileSync(pkg, 'utf8')).version
}

async function commandCheck(id: string, ctx: Context): Promise<Failure[]> {
  const cmd = ctx.rule.run
  if (typeof cmd !== 'string' || !cmd.trim())
    throw new ConfigError(`check "${id}" has no run command`)
  const timeout = Number(ctx.rule.timeout_sec ?? ctx.defaults.timeout_sec)
  const r = await runCommand(cmd, ctx.rule.cwd ? p(ctx, ctx.rule.cwd) : ctx.root, timeout)
  if (r.timedOut) {
    return [{
      code: 'CHECK_TIMEOUT',
      check: id,
      message: `\`${cmd}\` exceeded ${timeout}s`,
      detail: tail(r.output, ctx.defaults.max_detail_chars),
    }]
  }
  if (r.code === 0)
    return []
  return [{
    code: ctx.rule.code ?? COMMAND_CODES[id] ?? `${id.toUpperCase()}_FAIL`,
    check: id,
    message: `\`${cmd}\` exited with ${r.code}`,
    locations: extractLocations(r.output),
    detail: tail(r.output, ctx.defaults.max_detail_chars),
  }]
}

function artifactsCheck(ctx: Context): Failure[] {
  const dir = p(ctx, ctx.rule.dir ?? 'dist')
  if (!existsSync(dir))
    return [{ code: 'ARTIFACT_MISSING', check: 'artifacts', message: `output dir missing: ${ctx.rule.dir}` }]
  const missing = (ctx.rule.required ?? [] as string[]).filter((f: string) => !existsSync(join(dir, f)))
  return missing.map((f: string) => ({
    code: 'ARTIFACT_MISSING',
    check: 'artifacts',
    message: `required artifact missing: ${ctx.rule.dir}/${f}`,
  }))
}

function packageSizeCheck(ctx: Context): Failure[] {
  const dir = p(ctx, ctx.rule.dir)
  if (!existsSync(dir))
    return [{ code: 'ARTIFACT_MISSING', check: 'package_size', message: `output dir missing: ${ctx.rule.dir}` }]
  let subRoots: string[] = []
  const appJson = join(dir, 'app.json')
  if (existsSync(appJson)) {
    const app = JSON.parse(readFileSync(appJson, 'utf8'))
    subRoots = [...(app.subPackages ?? []), ...(app.subpackages ?? [])]
      .map((s: { root: string }) => s.root.replace(/^\/+|\/+$/g, ''))
  }
  const failures: Failure[] = []
  const totalKb = dirSizeBytes(dir) / 1024
  const mainKb = dirSizeBytes(dir, rel => subRoots.some(r => rel === r || rel.startsWith(`${r}/`))) / 1024
  if (ctx.rule.main_max_kb && mainKb > ctx.rule.main_max_kb) {
    failures.push({
      code: 'PACKAGE_TOO_LARGE',
      check: 'package_size',
      message: `main package ${mainKb.toFixed(0)}KB > ${ctx.rule.main_max_kb}KB`,
    })
  }
  if (ctx.rule.total_max_kb && totalKb > ctx.rule.total_max_kb) {
    failures.push({
      code: 'PACKAGE_TOO_LARGE',
      check: 'package_size',
      message: `total ${totalKb.toFixed(0)}KB > ${ctx.rule.total_max_kb}KB`,
    })
  }
  return failures
}

function unpackedCheck(ctx: Context): Failure[] {
  const dir = p(ctx, ctx.rule.dir ?? 'dist/win-unpacked')
  if (!existsSync(dir))
    return [{ code: 'ARTIFACT_MISSING', check: 'unpacked', message: `unpacked dir missing: ${ctx.rule.dir}` }]
  const asarPath = join(dir, ctx.rule.asar ?? 'resources/app.asar')
  if (!existsSync(asarPath))
    return [{ code: 'ARTIFACT_MISSING', check: 'unpacked', message: `asar missing: ${ctx.rule.asar}` }]

  let archive
  try {
    archive = openAsar(asarPath)
  }
  catch (e) {
    return [{ code: 'ARTIFACT_MISSING', check: 'unpacked', message: `asar unreadable: ${(e as Error).message}` }]
  }
  const entries = new Set(archive.entries)
  const failures: Failure[] = (ctx.rule.asar_required ?? [] as string[])
    .filter((e: string) => !entries.has(e.replace(/\\/g, '/')))
    .map((e: string) => ({ code: 'ASAR_MISSING_ENTRY', check: 'unpacked', message: `app.asar lacks ${e}` }))

  if (ctx.rule.check_version) {
    const expected = readProjectVersion(ctx.root)
    const raw = archive.readFile('package.json')
    const actual = raw ? JSON.parse(raw.toString('utf8')).version : undefined
    if (expected && actual !== expected) {
      failures.push({
        code: 'VERSION_MISMATCH',
        check: 'unpacked',
        message: `app.asar package.json version ${actual ?? '<none>'} != project ${expected}`,
      })
    }
  }
  return failures
}

async function installerCheck(ctx: Context): Promise<Failure[]> {
  const dir = p(ctx, ctx.rule.dir ?? 'dist')
  if (!existsSync(dir))
    return [{ code: 'ARTIFACT_MISSING', check: 'installer', message: `installer dir missing: ${ctx.rule.dir}` }]
  const re = globToRegExp(ctx.rule.pattern ?? '*.exe')
  const installers = walkFiles(dir, 0).filter(f => re.test(f))
  if (installers.length === 0)
    return [{ code: 'ARTIFACT_MISSING', check: 'installer', message: `no installer matches ${ctx.rule.pattern} in ${ctx.rule.dir}` }]

  const failures: Failure[] = []
  const version = readProjectVersion(ctx.root)

  if (ctx.rule.latest_yml) {
    const ymlPath = join(dir, ctx.rule.latest_yml)
    if (!existsSync(ymlPath)) {
      failures.push({ code: 'ARTIFACT_MISSING', check: 'installer', message: `${ctx.rule.latest_yml} missing` })
    }
    else {
      const latest = YAML.parse(readFileSync(ymlPath, 'utf8')) ?? {}
      if (version && String(latest.version) !== version) {
        failures.push({
          code: 'VERSION_MISMATCH',
          check: 'installer',
          message: `${ctx.rule.latest_yml} version ${latest.version} != package.json ${version}`,
        })
      }
      const files: { url: string, sha512?: string }[] = latest.files?.length
        ? latest.files
        : latest.path ? [{ url: latest.path, sha512: latest.sha512 }] : []
      for (const f of files) {
        const target = join(dir, decodeURIComponent(f.url))
        if (!existsSync(target)) {
          failures.push({ code: 'ARTIFACT_MISSING', check: 'installer', message: `${ctx.rule.latest_yml} references missing ${f.url}` })
          continue
        }
        if (f.sha512 && await hashFile(target, 'sha512', 'base64') !== f.sha512) {
          failures.push({ code: 'HASH_MISMATCH', check: 'installer', message: `sha512 of ${f.url} != ${ctx.rule.latest_yml}` })
        }
      }
    }
  }

  if (ctx.rule.sha256_file) {
    const sumPath = join(dir, ctx.rule.sha256_file)
    if (!existsSync(sumPath)) {
      failures.push({ code: 'ARTIFACT_MISSING', check: 'installer', message: `${ctx.rule.sha256_file} missing` })
    }
    else {
      for (const line of readFileSync(sumPath, 'utf8').split(/\r?\n/)) {
        const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
        if (!m)
          continue
        const target = join(dir, m[2])
        if (!existsSync(target))
          failures.push({ code: 'ARTIFACT_MISSING', check: 'installer', message: `${ctx.rule.sha256_file} references missing ${m[2]}` })
        else if (await hashFile(target, 'sha256', 'hex') !== m[1].toLowerCase())
          failures.push({ code: 'HASH_MISMATCH', check: 'installer', message: `sha256 of ${m[2]} mismatch` })
      }
    }
  }

  if (version && !installers.some(f => basename(f).includes(version))) {
    failures.push({
      code: 'VERSION_MISMATCH',
      check: 'installer',
      message: `no installer filename contains version ${version}: ${installers.join(', ')}`,
    })
  }
  return failures
}

function smokeCheck(ctx: Context): Promise<Failure[]> {
  const exe = p(ctx, ctx.rule.exe ?? '')
  if (!ctx.rule.exe || !existsSync(exe) || !statSync(exe).isFile())
    return Promise.resolve([{ code: 'ARTIFACT_MISSING', check: 'smoke', message: `smoke exe missing: ${ctx.rule.exe}` }])
  const aliveMs = Number(ctx.rule.alive_ms ?? 3000)
  return new Promise((done) => {
    const chunks: Buffer[] = []
    const child = spawn(exe, ctx.rule.args ?? [], {
      cwd: ctx.root,
      detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    })
    child.stdout?.on('data', (d: Buffer) => chunks.push(d))
    child.stderr?.on('data', (d: Buffer) => chunks.push(d))
    let settled = false
    const finish = (f: Failure[]) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      killTree(child.pid)
      done(f)
    }
    const crash = (why: string) => finish([{
      code: 'SMOKE_CRASH',
      check: 'smoke',
      message: `${basename(exe)} ${why} within ${aliveMs}ms`,
      detail: tail(Buffer.concat(chunks).toString('utf8'), ctx.defaults.max_detail_chars),
    }])
    const timer = setTimeout(() => finish([]), aliveMs)
    child.on('error', e => crash(`failed to start (${e.message})`))
    child.on('exit', (code, signal) => crash(`exited (code=${code}, signal=${signal})`))
  })
}

async function visualCheck(ctx: Context): Promise<Failure[]> {
  const exe = p(ctx, ctx.rule.exe ?? '')
  if (!ctx.rule.exe || !existsSync(exe))
    return [{ code: 'ARTIFACT_MISSING', check: 'visual', message: `visual exe missing: ${ctx.rule.exe}` }]
  const issues = await runVisual({
    ...ctx.rule,
    exe,
    screenshot: p(ctx, ctx.rule.screenshot ?? '.agent/visual.png'),
  }, ctx.root, ctx.defaults.max_detail_chars)
  return issues.map(i => ({ ...i, check: 'visual' }))
}

export async function runCheck(id: string, ctx: Context): Promise<Failure[]> {
  if (ctx.rule?.run)
    return commandCheck(id, ctx)
  switch (id) {
    case 'artifacts': return artifactsCheck(ctx)
    case 'package_size': return packageSizeCheck(ctx)
    case 'unpacked': return unpackedCheck(ctx)
    case 'installer': return installerCheck(ctx)
    case 'smoke': return smokeCheck(ctx)
    case 'visual': return visualCheck(ctx)
    default: throw new ConfigError(`unknown check "${id}" (no run command and not a built-in)`)
  }
}
