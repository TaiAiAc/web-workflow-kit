#!/usr/bin/env node
// 命令行入口（TS 核心）：
//   wwk fix    [--project <dir>]       对当前工作区跑门禁 ⇄ 审阅修复回环
//   wwk verify [--project <dir>]       只跑一次门禁，退出码 0/1/2
//   wwk run "<需求>" [--project <dir>]  完整流水线
//   wwk resume [线程] [--project <dir>] 从检查点继续被中断的运行（默认最近一次）
//   wwk init   [--project <dir>]       复制默认 rules.yaml、agent.config.json
// 公共参数：--agent / --fix-agent / --review / --config；--json 时 stdout 只输出结果 JSON，日志走 stderr。
// 退出码：0 交付 / 通过；1 熔断 / 门禁失败；2 用法或配置错误。
import process from "node:process"
import { parseArgs } from "node:util"
import { initProject, loadConfig } from "./config.ts"
import { defaultDeps } from "./deps.ts"
import { resume, runFixLoop, runPipeline } from "./graph.ts"
import type { State } from "./state.ts"

const USAGE = `用法：wwk <fix|verify|run|resume|init> [需求] [--project <dir>] [--agent <名称>] [--fix-agent <名称>] [--review auto|api|dsh|skip] [--config <文件>] [--json]`

function summary(state: State) {
  return {
    status: state.status ?? null,
    break_reason: state.break_reason ?? null,
    attempt: state.attempt ?? 0,
    verify_exit: state.verify_exit ?? null,
    summary: state.summary ?? "",
    failures: (state.failures ?? []).map(f => f.code),
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "project": { type: "string" },
      "config": { type: "string" },
      "agent": { type: "string" },
      "fix-agent": { type: "string" },
      "review": { type: "string" },
      "json": { type: "boolean", default: false },
      "help": { type: "boolean", short: "h", default: false },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    console.log(USAGE)
    return command ? 0 : 2
  }
  // --json：stdout 留给结果，日志一律走 stderr
  const log = values.json ? (line: string) => process.stderr.write(line + "\n") : (line: string) => console.log(line)

  if (command === "init") {
    for (const [file, created] of initProject(values.project ?? process.cwd()))
      log(`${created ? "已生成" : "已存在，未覆盖"}：${file}`)
    return 0
  }

  const cfg = loadConfig(values.project, values.config)
  const deps = defaultDeps(cfg, { log, codingAgent: values.agent, fixAgent: values["fix-agent"], reviewBackend: values.review })

  if (command === "verify") {
    const r = await deps.gate()
    if (values.json)
      console.log(JSON.stringify({ exit: r.exitCode, failures: r.failures }, null, 2))
    else
      log(r.passed ? "PASS" : `FAIL (exit ${r.exitCode})`)
    return r.exitCode
  }
  if (command === "fix" || command === "run" || command === "resume") {
    if (command === "run" && !rest[0]) {
      console.error("缺少需求：wwk run \"<需求>\"")
      return 2
    }
    const state = command === "fix" ? await runFixLoop(deps) : command === "run" ? await runPipeline(deps, rest[0]) : await resume(deps, rest[0])
    if (values.json)
      console.log(JSON.stringify(summary(state), null, 2))
    else
      log(state.summary ?? "")
    return state.status === "delivered" ? 0 : 1
  }
  console.error(USAGE)
  return 2
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(2)
  },
)
