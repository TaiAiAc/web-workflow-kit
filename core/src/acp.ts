// ACP 后端：驱动 Codex / OpenCode / WorkBuddy / Claude 等 ACP agent。
//
// 和 CLI 后端的差别：stop_reason 直接取自 ACP 的 session/prompt 结果，不用猜；
// 写文件等动作要走 session/request_permission，由这里的策略应答——门禁文件在这一层就改不了。
// 客户端不声明文件系统和终端能力，agent 自己读写文件，每次写都要先申请权限。
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import process from "node:process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import { type Agent, type AgentResult, END_TURN, ERROR, MAX_TOKENS } from "./agent-result.ts"
import { killTree, which } from "./proc.ts"

// 门禁与流水线自身：agent 无权修改
export const DEFAULT_PROTECTED = ["rules.yaml", "verify/*", "agent.config.json", ".agent/*", ".github/*", ".env", ".env.*"]
export const DEFAULT_ALLOW_KINDS = ["read", "search", "think", "edit"]
const WRITE_KINDS = new Set(["edit", "delete", "move"])

// 内置适配器（固定版本；本机装了同名命令时直接用它，见 localAdapter）
export const DEFAULT_COMMANDS: Record<string, string[]> = {
  claude: ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.81.0"],
  codex: ["npx", "--yes", "@agentclientprotocol/codex-acp@1.13.0"],
}

const STOP_REASONS: Record<string, string> = { end_turn: END_TURN, max_tokens: MAX_TOKENS, max_turn_requests: MAX_TOKENS }

/** refusal / cancelled / 缺失 一律按 error 处理，交给熔断。 */
export const mapStopReason = (reason: string | null | undefined): string => STOP_REASONS[reason ?? ""] ?? ERROR

const isWin = process.platform === "win32"

/** fnmatch 风格：* 匹配任意字符（含 /），? 匹配一个字符；Windows 上不区分大小写。 */
export function fnmatch(name: string, pattern: string): boolean {
  let re = ""
  for (const ch of pattern)
    re += ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${re}$`, isWin ? "i" : "").test(name)
}

/** 尽量解析成真实路径：已存在的部分解析符号链接（macOS 的 /var → /private/var），不存在的部分原样拼回。 */
function realish(p: string): string {
  const abs = resolve(p)
  let cur = abs
  const rest: string[] = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur)
      return abs
    rest.unshift(basename(cur))
    cur = parent
  }
  return join(realpathSync(cur), ...rest)
}

/** 相对项目根的 posix 路径；在项目外返回 null。 */
function relativeInProject(path: string, root: string): string | null {
  const rel = relative(realish(root), realish(isAbsolute(path) ? path : join(root, path)))
  if (isAbsolute(rel)) // Windows 上跨盘符
    return null
  return rel.replaceAll("\\", "/")
}

export interface ToolCallLike {
  toolCallId?: string | null
  kind?: string | null
  title?: string | null
  locations?: { path?: string | null }[] | null
  rawInput?: unknown
}

/**
 * 权限请求里的 toolCall 是增量（ToolCallUpdate）：有的 agent（如 CodeBuddy）只带 toolCallId 和 rawInput，
 * kind / title / locations 在之前的 tool_call 通知里。按 toolCallId 合并后再判断，否则一律被当成 'other' 拒掉。
 */
export function mergeToolCall(known: ToolCallLike | undefined, call: ToolCallLike): ToolCallLike {
  const out: ToolCallLike = { ...known }
  for (const [k, v] of Object.entries(call))
    if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !(k === "rawInput" && isEmptyObject(v)))
      (out as Record<string, unknown>)[k] = v
  return out
}
const isEmptyObject = (v: unknown) => typeof v === "object" && v !== null && !Object.keys(v).length

// 没有 locations 时从工具参数里找目标路径（各家字段名不同）
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file"]
function targetPaths(call: ToolCallLike): string[] {
  const locations = (call.locations ?? []).map(l => l?.path).filter((p): p is string => !!p)
  if (locations.length)
    return locations
  const input = (call.rawInput ?? {}) as Record<string, unknown>
  return PATH_KEYS.map(k => input[k]).filter((p): p is string => typeof p === "string" && !!p)
}

export function isAllowed(toolCall: ToolCallLike, root: string, allowKinds: string[], protectedPaths: string[]): [boolean, string] {
  const kind = toolCall.kind || "other"
  if (!allowKinds.includes(kind))
    return [false, `kind '${kind}' not allowed`]
  if (WRITE_KINDS.has(kind)) {
    const locations = targetPaths(toolCall)
    if (!locations.length)
      return [false, "write without a target path"]
    for (const raw of locations) {
      const rel = relativeInProject(raw, root)
      if (rel === null || rel === ".." || rel.startsWith("../"))
        return [false, `write outside project: ${raw}`]
      if (protectedPaths.some(p => fnmatch(rel, p)))
        return [false, `protected path: ${rel}`]
    }
  }
  return [true, "ok"]
}

/**
 * 不允许执行命令时，开头先说清楚：有的 agent（如 CodeBuddy）习惯用 ls / cat 浏览项目，
 * 命令一被拒就结束整轮。告诉它只用文件工具，检查交给流水线的门禁。
 */
export function withPolicyNote(prompt: string, allowKinds: string[]): string {
  if (allowKinds.includes("execute"))
    return prompt
  return "【运行环境说明】本环境会拒绝一切运行 shell 命令的请求（包括 ls、cat、grep、npm、git）。"
    + "浏览、搜索、读取、修改文件请只用你的文件读取 / 搜索 / 编辑工具；不要运行测试或构建，流水线的门禁会负责检查。\n\n" + prompt
}

/** 内置适配器默认经 npx 拉起，每次运行都要访问 npm；本机全局装了同名命令（如 codex-acp）时直接用它。 */
export function localAdapter(command: string[] | undefined, env?: NodeJS.ProcessEnv): string[] | undefined {
  if (!command || command[0] !== "npx")
    return command
  const spec = command.at(-1)!
  const at = spec.lastIndexOf("@")
  const pkg = at > 0 ? spec.slice(0, at) : spec // 去掉版本，保留 @scope
  const found = which(pkg.split("/").pop()!, env)
  return found ? [found] : command
}

export class ACPAgent implements Agent {
  readonly agent: string
  readonly command: string[] | null
  readonly model: string | null
  readonly allowKinds: string[]
  readonly protectedPaths: string[]
  readonly timeout: number
  readonly env: NodeJS.ProcessEnv | undefined

  constructor(opts: { agent?: string, command?: string[] | null, model?: string | null, allowKinds?: string[], protectedPaths?: string[], timeoutSec?: number, env?: NodeJS.ProcessEnv } = {}) {
    this.agent = opts.agent ?? "claude"
    this.command = opts.command ?? null
    this.model = opts.model ?? null
    this.allowKinds = opts.allowKinds ?? DEFAULT_ALLOW_KINDS
    this.protectedPaths = opts.protectedPaths ?? DEFAULT_PROTECTED
    this.timeout = opts.timeoutSec ?? 1800
    this.env = opts.env
  }

  async run(prompt: string, cwd: string): Promise<AgentResult> {
    const command = this.command ?? localAdapter(DEFAULT_COMMANDS[this.agent], this.env)
    if (!command?.length)
      return { stopReason: ERROR, text: `no ACP command for agent '${this.agent}'; set command in agent.config.json` }
    const exe = which(command[0], this.env) ?? command[0]
    const denied: string[] = []
    const calls = new Map<string, ToolCallLike>()   // toolCallId → 通知里报过的 kind / title / locations / rawInput
    let stderr = ""
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined
    try {
      child = spawn(exe, command.slice(1), {
        cwd,
        env: this.env ?? process.env,
        shell: isWin && /\.(cmd|bat)$/i.test(exe), // Windows 上 npx 是 npx.cmd
        windowsHide: true,
        detached: !isWin, // 适配器还会拉起 agent 本体：结束时整组一起结束
        stdio: ["pipe", "pipe", "pipe"],
      })
      child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)))
      // 进程起不来 / 中途退出时，连接上的请求不一定会失败，单独兜底
      const died = new Promise<never>((_, reject) => {
        child!.once("error", e => reject(new Error(`cannot start ${command[0]}: ${e.message}`)))
        child!.once("exit", code => reject(new Error(`agent process exited with code ${code}`)))
      })
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ACP ${this.agent} timed out after ${this.timeout}s`)), this.timeout * 1000)
      })
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      )
      const app = acp.client({ name: "web-workflow-kit" })
        .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
          const raw = params.toolCall as ToolCallLike
          const call = mergeToolCall(raw.toolCallId ? calls.get(raw.toolCallId) : undefined, raw)
          let [ok, why] = isAllowed(call, cwd, this.allowKinds, this.protectedPaths)
          if (ok) {
            const allow = params.options.find(o => o.kind === "allow_once")
            if (allow)
              return { outcome: { outcome: "selected", optionId: allow.optionId } }
            why = "no allow_once option offered"
          }
          denied.push(`${call.title || call.kind || "tool"}: ${why}`)
          // 拒绝要选 reject 选项：回 cancelled 在 ACP 里表示“整轮被取消”，agent 会直接停下而不是换个做法
          const reject = params.options.find(o => o.kind === "reject_once") ?? params.options.find(o => o.kind === "reject_always")
          return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } }
        })
      const work = app.connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        })
        return ctx.buildSession(resolve(cwd)).withSession(async (session) => {
          if (this.model) // 选模型是 ACP 的不稳定扩展（OpenCode 支持）；指定了却设不上就报错，不悄悄用默认模型
            await ctx.request("session/set_model", { sessionId: session.sessionId, modelId: this.model })
          const texts: string[] = []
          let toolCalls = 0
          const reading = (async () => {
            for (;;) {
              const m = await session.nextUpdate()
              if (m.kind === "stop")
                return
              const u = m.update
              if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
                texts.push(u.content.text)
              else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
                if (u.sessionUpdate === "tool_call")
                  toolCalls++
                const c = u as ToolCallLike
                if (c.toolCallId)
                  calls.set(c.toolCallId, mergeToolCall(calls.get(c.toolCallId), c))
              }
            }
          })()
          const response = await session.prompt(withPolicyNote(prompt, this.allowKinds))
          await reading
          const text = texts.join("")
          const tokens = (response as { usage?: { totalTokens?: number } }).usage?.totalTokens
          // 有的 agent 模型调用失败（Key 无效、没登录）时仍回 end_turn：什么都没做就当出错，别让门禁去背这个锅
          if (response.stopReason === "end_turn" && !text.trim() && !toolCalls && tokens === 0)
            return { stopReason: "error", text: "agent 本轮没有任何输出（0 token、无工具调用）：多半是登录失效、API Key 无效或模型不可用，请检查该 agent 的登录与模型设置" }
          return { stopReason: response.stopReason as string, text }
        })
      })
      const result = await Promise.race([work, died, timedOut])
      let text = result.text
      if (denied.length)
        text += `\n\n[denied permission requests]\n${denied.map(d => `- ${d}`).join("\n")}`
      return { stopReason: mapStopReason(result.stopReason), text }
    }
    catch (e) { // 连接失败、握手失败、协议错误、超时
      const msg = e instanceof Error ? e.message : String(e)
      const tail = stderr.trim() ? `\n[agent stderr]\n${stderr.trim().slice(-1500)}` : ""
      return { stopReason: ERROR, text: `ACP ${this.agent}: ${msg}${tail}` }
    }
    finally {
      clearTimeout(timer)
      if (child && child.exitCode === null)
        killTree(child.pid)
    }
  }
}
