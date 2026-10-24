// 看图用的最小 ACP agent 桩：initialize 时声明支持图片（STUB_NO_IMAGE 时不声明），
// 收到 prompt 后把收到的图片块数量和 MIME 写进回复正文。不调用任何模型。
import { createInterface } from "node:readline"

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n")
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    const promptCapabilities = process.env.STUB_NO_IMAGE ? {} : { image: true }
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities } } })
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "vision-1" } })
  } else if (msg.method === "session/prompt") {
    const blocks = msg.params.prompt
    const images = blocks.filter(b => b.type === "image")
    const text = `## 概览\n\n图1 是登录页。ACP 收到 images=${images.length} mime=${images.map(i => i.mimeType).join(",")} base64=${images.every(i => i.data.length > 0)}\n\n## 不确定的地方\n\n无`
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "vision-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })
  } else if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
}
