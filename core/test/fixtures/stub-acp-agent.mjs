// 最小 ACP agent 桩：按 STUB_WRITES 逐个申请写文件权限，
// 获批才真的写，最后以 STUB_STOP 结束本轮。只用于测试 ACPAgent 的权限策略与 stop_reason 映射，不调用任何模型。
// STUB_EMPTY：模拟模型调用失败却仍回 end_turn（不输出、0 token）；session/set_model 设的模型会写进回复。
// STUB_DIRECT：像 codex-acp 那样不申请权限，直接写这些文件（; 分隔）。session/set_mode 设的模式也写进回复。
// STUB_SPLIT：像 CodeBuddy 那样，kind / title / locations 只在先发的 tool_call 通知里，权限请求只带 toolCallId 和 rawInput。
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createInterface } from "node:readline"

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n")
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const read = async () => {
  const { value, done } = await lines.next()
  if (done) process.exit(0)
  return JSON.parse(value)
}
let nextId = 1000
let cwd = process.cwd()
let model = "default"
let mode = "default"

const outcomes = []
async function askPermission(sessionId, path) {
  const id = ++nextId
  const full = { toolCallId: `t${id}`, title: `Edit ${path}`, kind: "edit", locations: [{ path }] }
  if (process.env.STUB_SPLIT)
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", ...full, status: "pending", rawInput: { file_path: path } } } })
  send({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
    sessionId,
    toolCall: process.env.STUB_SPLIT ? { toolCallId: full.toolCallId, rawInput: { file_path: path } } : full,
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
  } })
  for (;;) {
    const msg = await read()
    if (msg.id === id) {
      const o = msg.result?.outcome
      outcomes.push(o?.outcome === "selected" ? o.optionId : o?.outcome)
      return o?.optionId === "allow"
    }
  }
}

for (;;) {
  const msg = await read()
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  } else if (msg.method === "session/new") {
    cwd = msg.params.cwd
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "stub-1" } })
  } else if (msg.method === "session/set_model") {
    model = msg.params.modelId
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  } else if (msg.method === "session/set_mode") {
    mode = msg.params.modeId
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  } else if (msg.method === "session/prompt" && process.env.STUB_EMPTY) {
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } } })
  } else if (msg.method === "session/prompt") {
    const wrote = [], denied = []
    for (const rel of (process.env.STUB_DIRECT || "").split(";").filter(Boolean)) {
      if (rel.startsWith("-")) rmSync(resolve(cwd, rel.slice(1)), { force: true })
      else {
        mkdirSync(dirname(resolve(cwd, rel)), { recursive: true })
        writeFileSync(resolve(cwd, rel), "direct\n")
      }
    }
    for (const rel of (process.env.STUB_WRITES || "").split(";").filter(Boolean)) {
      const target = resolve(cwd, rel)
      if (await askPermission("stub-1", target)) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, "patched\n")
        wrote.push(rel)
      } else denied.push(rel)
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stub-1", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: `wrote=${wrote} denied=${denied} model=${model} mode=${mode} outcomes=${outcomes}` },
    } } })
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: process.env.STUB_STOP || "end_turn" } })
  } else if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
}
