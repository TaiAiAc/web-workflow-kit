// 各 agent 对会话级模型 / 思考强度的能力。ACP 适配器的可选项以 session/new 返回为准；
// 只有命令行原生参数固定下来的能力才放在这里，UI 和后端共用同一份判断，避免“能选但没传”。

export interface AgentOptionChoice {
  value: string
  name: string
  description?: string | null
}

export interface AgentControl {
  supported: boolean
  source: "session" | "cli" | null
  choices: AgentOptionChoice[]
  reason?: string | null
}

export interface AgentControls {
  model: AgentControl
  effort: AgentControl
}

const choices = (...values: string[]): AgentOptionChoice[] => values.map(value => ({ value, name: value }))

const CLAUDE_MODELS = choices("fable", "opus", "sonnet")
const CLAUDE_EFFORTS = choices("low", "medium", "high", "xhigh", "max")
const WORKBUDDY_MODELS = choices(
  "hy4-preview",
  "hy3",
  "hy3-x",
  "step-5-preview",
  "space-bunny",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "minimax-m3.1-flash",
  "minimax-m3",
  "minimax-m2.7",
  "kimi-k3.1-pro",
  "kimi-k3-1-preview",
  "kimi-k2.8-preview",
  "deepseek-v4-pro",
  "mimo-v2.6-pro",
)
const WORKBUDDY_EFFORTS = choices("minimal", "low", "medium", "high", "xhigh", "max")

const unsupported = (reason: string): AgentControl => ({ supported: false, source: null, choices: [], reason })
const dynamic = (): AgentControl => ({ supported: true, source: "session", choices: [], reason: null })
const fixed = (source: "cli" | "session", options: AgentOptionChoice[], reason: string | null = null): AgentControl =>
  ({ supported: true, source, choices: options, reason })

export function agentKind(preset: Record<string, any>): string {
  const backend = preset.backend ?? "claude_cli"
  if (backend === "claude_cli")
    return "claude"
  if (backend === "acp")
    return String(preset.agent ?? "acp")
  return backend
}

export function agentControls(preset: Record<string, any>): AgentControls {
  const backend = preset.backend ?? "claude_cli"
  if (backend === "claude_cli")
    return { model: fixed("cli", CLAUDE_MODELS), effort: fixed("cli", CLAUDE_EFFORTS) }
  if (backend === "dsh_cli" || backend === "command")
    return {
      model: unsupported("该命令行 agent 没有模型选择开关"),
      effort: unsupported("该命令行 agent 没有思考强度开关"),
    }
  if (backend !== "acp")
    return {
      model: unsupported("未知后端不支持模型选择"),
      effort: unsupported("未知后端不支持思考强度"),
    }

  const kind = String(preset.agent ?? "")
  if (kind === "opencode")
    return {
      model: dynamic(),
      effort: unsupported("OpenCode 的 ACP 会话只提供模型列表，不提供独立的思考强度设置"),
    }
  if (kind === "workbuddy")
    return { model: fixed("cli", WORKBUDDY_MODELS), effort: fixed("cli", WORKBUDDY_EFFORTS) }
  // codex-acp 和后续适配器通过 session/new 的 configOptions 报告真实能力。
  return { model: dynamic(), effort: dynamic() }
}

export function assertAgentOptions(preset: Record<string, any>, model?: string | null, effort?: string | null): void {
  const controls = agentControls(preset)
  const kind = String(preset.label || agentKind(preset))
  if (model && !controls.model.supported)
    throw new Error(`${kind} 不支持选择模型：${controls.model.reason ?? "没有模型开关"}`)
  if (effort && !controls.effort.supported)
    throw new Error(`${kind} 不支持设置思考强度：${controls.effort.reason ?? "没有思考强度开关"}`)
  if (effort && controls.effort.choices.length && !controls.effort.choices.some(o => o.value === effort))
    throw new Error(`${kind} 不支持思考强度「${effort}」（可选：${controls.effort.choices.map(o => o.value).join(" / ")}）`)
}

/** CodeBuddy 在 ACP 启动参数里接受 --model / --effort；它们只影响这一次新会话。 */
export function withWorkBuddyLaunchOptions(command: string[] | null | undefined, model?: string | null, effort?: string | null): string[] | null | undefined {
  if (!command)
    return command
  const out = [...command]
  if (model)
    out.push("--model", model)
  if (effort)
    out.push("--effort", effort)
  return out
}
