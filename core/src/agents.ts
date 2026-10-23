// 外部编程 agent 的统一接口：只关心 stop_reason，不解析自然语言（与 Python 版 agents.py 一致）。
import { join } from "node:path"
import { ACPAgent } from "./acp.ts"
import { type Agent, type AgentResult, END_TURN, ERROR, MAX_TOKENS } from "./agent-result.ts"
import { type Config, relativeTo, writeText } from "./config.ts"
import { run, which } from "./proc.ts"

export { type Agent, type AgentResult, END_TURN, ERROR, MAX_TOKENS }

/** `claude -p --output-format json`，prompt 走 stdin，避开命令行长度和转义问题。 */
export class ClaudeCodeCLI implements Agent {
  readonly model: string | null
  readonly permissionMode: string | null
  readonly maxTurns: number | null
  readonly timeout: number
  readonly env: NodeJS.ProcessEnv | undefined

  constructor(opts: { model?: string | null, permissionMode?: string | null, maxTurns?: number | null, timeoutSec?: number, env?: NodeJS.ProcessEnv } = {}) {
    this.model = opts.model ?? null
    this.permissionMode = opts.permissionMode ?? null
    this.maxTurns = opts.maxTurns ?? null
    this.timeout = opts.timeoutSec ?? 1800
    this.env = opts.env
  }

  async run(prompt: string, cwd: string): Promise<AgentResult> {
    const exe = which("claude", this.env)
    if (!exe)
      return { stopReason: ERROR, text: "claude CLI not found on PATH" }
    const args = ["-p", "--output-format", "json"]
    if (this.model)
      args.push("--model", this.model)
    if (this.permissionMode)
      args.push("--permission-mode", this.permissionMode)
    if (this.maxTurns)
      args.push("--max-turns", String(this.maxTurns))
    const r = await run(exe, args, { cwd, input: prompt, env: this.env, timeoutMs: this.timeout * 1000 })
    if (r.timedOut)
      return { stopReason: ERROR, text: `claude timed out after ${this.timeout}s` }
    let data: Record<string, any>
    try {
      data = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "")
    }
    catch {
      return { stopReason: ERROR, text: (r.stderr || r.stdout).slice(-2000) }
    }
    const failed = data.is_error || r.code !== 0
    const stopReason = !failed ? END_TURN : data.subtype === "error_max_turns" ? MAX_TOKENS : ERROR
    return { stopReason, text: String(data.result ?? "") }
  }
}

/**
 * 通用命令行 agent（默认 DeepSeek Harness：`dsh headless "<prompt>"`）。
 * 长 prompt 写进文件，命令行只传一句英文指令，避免 cmd.exe 的长度/编码问题。
 */
export class CommandAgent implements Agent {
  readonly command: string[]
  readonly taskFile: string
  readonly timeout: number
  readonly env: NodeJS.ProcessEnv | undefined

  constructor(command: string[], taskFile: string, timeoutSec = 1800, env?: NodeJS.ProcessEnv) {
    this.command = command
    this.taskFile = taskFile
    this.timeout = timeoutSec
    this.env = env
  }

  async run(prompt: string, cwd: string): Promise<AgentResult> {
    const exe = which(this.command[0], this.env)
    if (!exe)
      return { stopReason: ERROR, text: `${this.command[0]} not found on PATH` }
    writeText(this.taskFile, prompt)
    // 同一个 agent 既可能写代码也可能修复：指令保持通用，具体任务在文件里
    const short = `Read ${relativeTo(this.taskFile, cwd)} and carry out the task it describes, then stop.`
    const args = this.command.slice(1).map(a => a.replaceAll("{prompt}", short))
    const r = await run(exe, args, { cwd, env: this.env, timeoutMs: this.timeout * 1000 })
    if (r.timedOut)
      return { stopReason: ERROR, text: `${this.command[0]} timed out after ${this.timeout}s` }
    return { stopReason: r.code === 0 ? END_TURN : ERROR, text: (r.stdout + r.stderr).slice(-4000) }
  }
}

/** 可选的编程 agent：{key: 预设}。项目的 agent.config.json 可以改预设或加新的。 */
export function codingAgentChoices(cfg: Config): Record<string, Record<string, any>> {
  return cfg.raw.coding_agents ?? {}
}

/** 只查命令在不在 PATH 上；登录状态要真正调用时才知道。 */
export function agentAvailability(preset: Record<string, any>, env?: NodeJS.ProcessEnv): [boolean, string] {
  const exe: string | undefined = preset.requires ?? preset.command?.[0]
  if (!exe)
    return [true, ""]
  const found = which(exe, env)
  return found ? [true, found] : [false, `未找到 ${exe} 命令`]
}

/** 按选择构建“写代码”的 agent：预设（coding_agents.<key>）+ code 段的公共项（如超时）。 */
export function buildCodingAgent(cfg: Config, choice?: string | null): Agent {
  const code = cfg.get("code")
  const key = choice || code.agent || "claude"
  const presets = codingAgentChoices(cfg)
  if (!(key in presets))
    throw new Error(`未知的编程 agent：${key}（可选：${Object.keys(presets).join(", ")}）`)
  const { agent: _ignored, ...common } = code
  return buildAgent({ ...common, ...presets[key] }, cfg, "code-task")
}

export function buildAgent(section: Record<string, any>, cfg: Config, taskName: string): Agent {
  const backend = section.backend ?? "claude_cli"
  const env = cfg.childEnv()
  const timeoutSec = Number(section.timeout_sec ?? 1800)
  if (backend === "claude_cli")
    return new ClaudeCodeCLI({ model: section.model, permissionMode: section.permission_mode, maxTurns: section.max_turns, timeoutSec, env })
  if (backend === "dsh_cli" || backend === "command")
    return new CommandAgent(section.command, join(cfg.stateDir, `${taskName}.md`), timeoutSec, env)
  if (backend === "acp")
    return new ACPAgent({ agent: section.agent, command: section.command, model: section.model, allowKinds: section.allow_kinds, protectedPaths: section.protected, timeoutSec, env })
  throw new Error(`unknown agent backend: ${backend}`)
}
