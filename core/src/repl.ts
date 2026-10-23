// 交互模式：`wwk`（不带命令）进 REPL，直接输入需求就跑完整流水线（与 Python 版 cli.py 的 REPL 一致）。
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { createInterface } from "node:readline"
import { type Config, loadConfig, writeText } from "./config.ts"
import { type Deps, defaultDeps } from "./deps.ts"
import { buildCodeGraph, resume, runFixLoop, runPipeline } from "./graph.ts"
import type { State } from "./state.ts"

export const HELP = `直接输入需求       → 跑完整流水线（Spec → 代码 → 门禁 ⇄ 修复 → 交付/熔断）
:design <ref|off>  设置下一次需求使用的设计稿（本地 .json，或 mastergo 读 MasterGo 当前选中的图层）
:code <需求>       只跑编码（Spec + 写代码），不过门禁
:verify            只跑门禁 verify（零 token）
:fix               对当前工作区跑 门禁 ⇄ 审阅/修复 闭环（人工修完后复验也用它）
:resume [线程]     从检查点继续被中断的运行（默认最近一次）
:project <dir>     切换目标项目
:agent <名称>      切换编程 agent：claude / codex / opencode / workbuddy / dsh
:status            上一次运行结果
:help / :q`

export function summary(state: Partial<State>): string {
  return JSON.stringify({
    summary: state.summary, status: state.status, break_reason: state.break_reason,
    attempt: state.attempt, verify_exit: state.verify_exit, history: state.history,
    failures: (state.failures ?? []).map(f => `${f.code}: ${f.message}`),
  }, null, 2)
}

export interface ReplOptions {
  project?: string
  config?: string
  agent?: string
  fixAgent?: string
  review?: string
  version: string
}

export async function repl(opts: ReplOptions): Promise<number> {
  let cfg: Config = loadConfig(opts.project, opts.config)
  let agent = opts.agent
  const build = () => defaultDeps(cfg, { codingAgent: agent, fixAgent: opts.fixAgent, reviewBackend: opts.review })
  let deps: Deps = build()
  const historyFile = () => join(cfg.stateDir, "repl_history")
  let history: string[] = []
  try {
    history = readFileSync(historyFile(), "utf8").split("\n").filter(Boolean).reverse().slice(0, 500)
  }
  catch {}
  const rl = createInterface({ input: process.stdin, output: process.stdout, history, historySize: 500, prompt: "需求> " })
  const remember = (line: string) => {
    try {
      appendFileSync(historyFile(), `${line}\n`)
    }
    catch {
      writeText(historyFile(), `${line}\n`)
    }
  }

  console.log(`wwk ${opts.version} · project=${cfg.projectRoot} · max_retries=${cfg.maxRetries}  (:help)`)
  let designRef: string | null = null
  let last: Partial<State> = {}
  let busy = false
  let closed = false // 管道输入读完时 readline 会先关上，已缓冲的命令照常执行，只是不再出提示符
  rl.on("close", () => (closed = true))
  const prompt = () => {
    if (!closed)
      rl.prompt()
  }
  rl.on("SIGINT", () => {
    if (busy) // 运行中按 Ctrl+C：当前这一轮作废，REPL 不退出（agent 子进程随超时或下一次运行结束）
      console.log("\n(已中断：等当前步骤结束后回到提示符)")
    else
      rl.close()
  })
  prompt()
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) {
      prompt()
      continue
    }
    remember(line)
    const i = line.indexOf(" ")
    const cmd = i < 0 ? line : line.slice(0, i)
    const arg = i < 0 ? "" : line.slice(i + 1).trim()
    busy = true
    try {
      if ([":q", ":quit", ":exit"].includes(cmd))
        break
      else if (cmd === ":help")
        console.log(HELP)
      else if (cmd === ":design") {
        designRef = !arg || arg === "off" ? null : arg
        console.log(`design = ${designRef}`)
      }
      else if (cmd === ":agent") {
        agent = arg || undefined
        deps = build()
        console.log(`编程 agent = ${agent ?? cfg.get("code").agent}`)
      }
      else if (cmd === ":project") {
        cfg = loadConfig(arg || undefined, opts.config)
        deps = build()
        console.log(`project = ${cfg.projectRoot}`)
      }
      else if (cmd === ":verify") {
        const r = await deps.gate()
        console.log(r.passed ? "PASS" : `FAIL (exit ${r.exitCode})`)
        for (const f of r.failures)
          console.log(`  ${f.code}: ${f.message}`)
      }
      else if (cmd === ":fix") {
        last = await runFixLoop(deps)
        console.log(summary(last))
      }
      else if (cmd === ":resume") {
        last = await resume(deps, arg || null)
        console.log(summary(last))
      }
      else if (cmd === ":code") {
        if (!arg) {
          console.log("用法：:code <需求>")
        }
        else {
          last = await buildCodeGraph(deps).invoke({ requirement: arg, project_root: cfg.projectRoot, design_ref: designRef })
          console.log(`stop_reason=${last.code_stop_reason} break=${last.break_reason ?? null}`)
        }
      }
      else if (cmd === ":status") {
        console.log(Object.keys(last).length ? summary(last) : "(还没有运行记录)")
      }
      else if (cmd.startsWith(":")) {
        console.log(`未知命令 ${cmd}，:help 查看`)
      }
      else {
        last = await runPipeline(deps, line, designRef)
        console.log(summary(last))
        designRef = null
      }
    }
    catch (e) { // REPL 不因单次失败退出
      console.error(`error: ${(e as Error).name}: ${(e as Error).message}`)
    }
    finally {
      busy = false
    }
    prompt()
  }
  rl.close()
  console.log()
  return 0
}
