// agent 的统一结果：只关心 stop_reason，不解析自然语言。单独成文件，acp.ts 与 agents.ts 都依赖它而不互相依赖。
export const END_TURN = "end_turn"
export const MAX_TOKENS = "max_tokens"
export const ERROR = "error"

export interface AgentResult {
  stopReason: string
  text: string
}

export interface Agent {
  run: (prompt: string, cwd: string) => Promise<AgentResult>
}
