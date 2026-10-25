#!/usr/bin/env node
// 命令行入口（TS 核心）：
//   wwk        [--project <dir>]       交互模式（REPL）：直接输入需求跑完整流水线，:help 看命令
//   wwk repl   [--project <dir>]       同上，但不要求终端（可以用管道喂命令）
//   wwk fix    [--project <dir>]       对当前工作区跑门禁 ⇄ 审阅修复回环
//   wwk verify [--project <dir>]       只跑一次门禁，退出码 0/1/2
//   wwk run "<需求>" [--design <ref>]  完整流水线；--design 附带设计稿（本地 .json 或 mastergo）
//   wwk resume [线程] [--project <dir>] 从检查点继续被中断的运行（默认最近一次）
//   wwk init   [--project <dir>]       复制默认 rules.yaml、agent.config.json
//   wwk ui     [--port 8765] [--no-browser]  打开本地控制台（桌面端也是起这个）
// 公共参数：--agent / --fix-agent / --review / --config；--json 时 stdout 只输出结果 JSON，日志走 stderr。
// 退出码：0 交付 / 通过；1 熔断 / 门禁失败；2 用法或配置错误。
import { spawn } from "node:child_process"
import process from "node:process"
import { parseArgs } from "node:util"
import { initProject, loadConfig } from "./config.ts"
import { startConsole } from "./console/server.ts"
import { defaultDeps } from "./deps.ts"
import { resume, runFixLoop, runPipeline } from "./graph.ts"
import { Metrics, metricsFile } from "./metrics.ts"
import { repl, summary as replSummary } from "./repl.ts"
import type { State } from "./state.ts"

// 打包时由 build.mjs 注入 package.json 的版本；源码直接跑时是 dev
declare const __WWK_VERSION__: string | undefined
export const VERSION = typeof __WWK_VERSION__ === "string" ? __WWK_VERSION__ : "dev"

const USAGE = `用法：wwk [fix|verify|run|resume|init|ui|repl] [需求] [--project <dir>] [--agent <名称>] [--fix-agent <名称>] [--product-agent|--tech-agent|--vision-agent|--arbiter-agent <名称>] [--review auto|api|dsh|skip|<编程 agent>] [--design <ref>] [--config <文件>] [--json] [--version]
不带命令进交互模式（REPL）。`

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
      "product-agent": { type: "string" },
      "tech-agent": { type: "string" },
      "vision-agent": { type: "string" },
      "arbiter-agent": { type: "string" },
      "review": { type: "string" },
      "json": { type: "boolean", default: false },
      "port": { type: "string", default: "8765" },
      "no-browser": { type: "boolean", default: false },
      "design": { type: "string" },
      "version": { type: "boolean", short: "v", default: false },
      "help": { type: "boolean", short: "h", default: false },
    },
  })
  const [command, ...rest] = positionals
  if (values.version) {
    console.log(`web-workflow-kit ${VERSION}`)
    return 0
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (!command || command === "repl") { // 不带命令：终端里进交互模式；被管道调用时没人能输入，按用法错误处理
    if (!command && !process.stdin.isTTY) {
      console.error(USAGE)
      return 2
    }
    return repl({ project: values.project, config: values.config, agent: values.agent, fixAgent: values["fix-agent"], review: values.review, version: VERSION })
  }
  // --json：stdout 留给结果，日志一律走 stderr
  const log = values.json ? (line: string) => process.stderr.write(line + "\n") : (line: string) => console.log(line)

  if (command === "ui")
    return ui(Number(values.port), !values["no-browser"])

  if (command === "init") {
    for (const [file, created] of initProject(values.project ?? process.cwd()))
      log(`${created ? "已生成" : "已存在，未覆盖"}：${file}`)
    return 0
  }

  const cfg = loadConfig(values.project, values.config)
  const runId = `cli-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`
  const roles = { product: values["product-agent"], tech: values["tech-agent"], vision: values["vision-agent"], arbiter: values["arbiter-agent"] }
  const deps = defaultDeps(cfg, { log, codingAgent: values.agent, fixAgent: values["fix-agent"], reviewBackend: values.review, roles, metrics: new Metrics(metricsFile(cfg.stateDir, runId)) })

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
    const state = command === "fix" ? await runFixLoop(deps) : command === "run" ? await runPipeline(deps, rest[0], values.design) : await resume(deps, rest[0])
    if (values.json)
      console.log(JSON.stringify(summary(state), null, 2))
    else
      log(replSummary(state))
    return state.status === "delivered" ? 0 : 1
  }
  console.error(USAGE)
  return 2
}

async function ui(port: number, openBrowser: boolean): Promise<number> {
  let c
  try {
    c = await startConsole({ port })
  }
  catch (e) {
    console.error(`端口 ${port} 无法使用（${(e as Error).message}）。换一个：wwk ui --port ${port + 1}`)
    return 1
  }
  // 桌面端按这一行里的地址加载页面，措辞改了要同步 desktop/main/backend.ts
  console.log(`前端交付流水线 · 本地控制台已启动：${c.url}`)
  console.log("只监听本机；按 Ctrl+C 停止。")
  if (openBrowser) {
    const [cmd, args] = process.platform === "darwin" ? ["open", [c.url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", c.url]] : ["xdg-open", [c.url]]
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref()
  }
  await new Promise<void>((resolve) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.once(sig, () => void c.close().then(resolve))
  })
  console.log("已停止")
  return 0
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(2)
  },
)
