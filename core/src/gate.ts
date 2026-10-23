// 调用门禁脚本。放行只看退出码；报告 JSON 只用来把失败项喂给下游（与 Python 版 gate.py 一致）。
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { type Config, VERIFY_BUNDLE } from "./config.ts"
import { run, which } from "./proc.ts"

export interface Failure {
  code: string
  check: string
  message: string
  locations?: string[]
  detail?: string
}

export class GateResult {
  readonly exitCode: number
  readonly failures: Failure[]

  constructor(exitCode: number, failures: Failure[] = []) {
    this.exitCode = exitCode
    this.failures = failures
  }

  get passed(): boolean {
    return this.exitCode === 0
  }
}

/** log 为空时输出直接进终端；否则逐行转给 log（控制台靠它实时显示每项检查）。 */
export async function runGate(cfg: Config, opts: { only?: string[], log?: (line: string) => void } = {}): Promise<GateResult> {
  const env = cfg.childEnv()
  const node = which("node", env)
  if (!node)
    return new GateResult(2, [{ code: "CONFIG_ERROR", check: "gate", message: "node not found on PATH" }])
  if (!existsSync(VERIFY_BUNDLE))
    return new GateResult(2, [{ code: "CONFIG_ERROR", check: "gate", message: `${VERIFY_BUNDLE} missing; run \`pnpm build\` in verify/` }])

  const out = join(cfg.stateDir, "verify-report.json")
  mkdirSync(cfg.stateDir, { recursive: true })
  rmSync(out, { force: true })
  const vcfg = cfg.get("verify")
  const args = [VERIFY_BUNDLE, "--cwd", cfg.projectRoot, "--out", out]
  if (vcfg.rules)
    args.push("--rules", resolve(cfg.projectRoot, vcfg.rules))
  if (vcfg.type)
    args.push("--type", vcfg.type)
  if (opts.only?.length)
    args.push("--only", opts.only.join(","))

  const log = opts.log ?? ((line: string) => console.log(line))
  const r = await run(node, args, {
    cwd: cfg.projectRoot,
    env,
    timeoutMs: Number(vcfg.timeout_sec ?? 3600) * 1000,
    onLine: line => log("  " + line.trimEnd()),
  })
  if (r.timedOut)
    return new GateResult(1, [{ code: "CHECK_TIMEOUT", check: "gate", message: "verify.ts exceeded overall timeout" }])

  const code = r.code ?? 2
  let failures: Failure[] = []
  if (existsSync(out))
    failures = JSON.parse(readFileSync(out, "utf8")).failures ?? []
  if (code !== 0 && !failures.length)
    failures = [{ code: "CONFIG_ERROR", check: "gate", message: `verify.ts exited ${code} without a report` }]
  // 退出码就是结论；报告里写了什么都不改变它
  return new GateResult(code, failures)
}
