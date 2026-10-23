// 门禁：exit code 是唯一放行权。0 放行 / 1 门禁失败 / 2 规则或用法错误。
// 用法：tsx verify.ts [--rules rules.yaml] [--cwd <project>] [--type electron|web|uniapp|miniprogram]
//                    [--only a,b] [--skip a,b] [--json] [--out report.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
import {
  ARTIFACT_CHECKS,
  type CheckResult,
  ConfigError,
  type Defaults,
  type Failure,
  PROJECT_TYPES,
  type ProjectType,
  runCheck,
} from './lib/checks.ts'

export interface Report {
  pass: boolean
  exit_code: 0 | 1 | 2
  project_type: ProjectType | null
  root: string
  rules: string
  checks: Omit<CheckResult, 'failures'>[]
  failures: Failure[]
  generated_at: string
}

// 前置检查失败时，后面依赖它的检查直接 skip，不制造连带失败项
const DEPENDS_ON: Record<string, Set<string>> = {
  build: ARTIFACT_CHECKS,
  smoke: new Set(['visual']), // 主进程都起不来，视觉验收只会再报一次 VISUAL_UNAVAILABLE
}

// 默认规则：打包后与 verify.mjs 同在 assets/；源码运行时在 ../assets/
const HERE = dirname(fileURLToPath(import.meta.url))
const KIT_RULES = [resolve(HERE, 'rules.yaml'), resolve(HERE, '..', 'assets', 'rules.yaml')]
  .find(p => existsSync(p)) ?? resolve(HERE, 'rules.yaml')

export interface VerifyOptions {
  cwd?: string
  rules?: string
  type?: string
  only?: string[]
  skip?: string[]
  log?: (line: string) => void
}

export async function verify(opts: VerifyOptions = {}): Promise<Report> {
  const root = resolve(opts.cwd ?? process.cwd())
  const log = opts.log ?? (() => {})
  const rulesPath = resolve(opts.rules ?? (existsSync(resolve(root, 'rules.yaml')) ? resolve(root, 'rules.yaml') : KIT_RULES))
  const report: Report = {
    pass: false,
    exit_code: 2,
    project_type: null,
    root,
    rules: rulesPath,
    checks: [],
    failures: [],
    generated_at: new Date().toISOString(),
  }
  const configError = (message: string): Report => {
    report.failures.push({ code: 'CONFIG_ERROR', check: 'rules', message })
    return report
  }

  let rules: any
  try {
    rules = YAML.parse(readFileSync(rulesPath, 'utf8'))
  }
  catch (e) {
    return configError(`cannot read ${rulesPath}: ${(e as Error).message}`)
  }
  const type = (opts.type ?? rules?.project_type) as ProjectType
  if (!PROJECT_TYPES.includes(type))
    return configError(`project_type must be one of ${PROJECT_TYPES.join('|')}, got ${type}`)
  report.project_type = type
  const profile = rules.profiles?.[type]
  if (!profile || !Array.isArray(profile.checks))
    return configError(`profiles.${type}.checks is missing`)

  const defaults: Defaults = {
    timeout_sec: 900,
    max_detail_chars: 3000,
    fail_fast: false,
    ...rules.defaults,
  }
  const ids: string[] = profile.checks
    .filter((id: string) => !opts.only?.length || opts.only.includes(id))
    .filter((id: string) => !opts.skip?.includes(id))

  const failed = new Set<string>()
  let stop = false
  for (const id of ids) {
    const rule = profile[id] ?? rules.commands?.[id] ?? {}
    const started = Date.now()
    const blockedBy = [...failed].find(dep => DEPENDS_ON[dep]?.has(id))
    if (stop || blockedBy) {
      report.checks.push({ id, status: 'skip', duration_ms: 0, reason: stop ? 'fail_fast' : `${blockedBy} failed` })
      log(`- ${id}: skip`)
      continue
    }
    let failures: Failure[]
    try {
      failures = await runCheck(id, { root, type, defaults, rule })
    }
    catch (e) {
      if (e instanceof ConfigError)
        return configError(e.message)
      failures = [{ code: 'CONFIG_ERROR', check: id, message: `check crashed: ${(e as Error).stack ?? e}` }]
    }
    const status = failures.length ? 'fail' : 'pass'
    report.checks.push({ id, status, duration_ms: Date.now() - started })
    report.failures.push(...failures)
    log(`${status === 'pass' ? '✔' : '✘'} ${id} (${Date.now() - started}ms)${failures.map(f => `\n    ${f.code}: ${f.message}`).join('')}`)
    if (failures.length)
      failed.add(id)
    if (failures.length && defaults.fail_fast)
      stop = true
  }

  report.pass = report.failures.length === 0
  report.exit_code = report.pass ? 0 : 1
  return report
}

async function main() {
  const { values } = parseArgs({
    options: {
      rules: { type: 'string' },
      cwd: { type: 'string' },
      type: { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  })
  const list = (s?: string) => s?.split(',').map(x => x.trim()).filter(Boolean)
  // 人读日志走 stderr，stdout 只留 JSON，方便编排层解析
  const report = await verify({
    cwd: values.cwd,
    rules: values.rules,
    type: values.type,
    only: list(values.only),
    skip: list(values.skip),
    log: line => process.stderr.write(`${line}\n`),
  })
  const json = JSON.stringify(report, null, 2)
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true })
    writeFileSync(resolve(values.out), json)
  }
  if (values.json)
    process.stdout.write(`${json}\n`)
  process.stderr.write(report.pass ? 'VERIFY PASS\n' : `VERIFY FAIL (${report.failures.map(f => f.code).join(', ')})\n`)
  process.exitCode = report.exit_code
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
