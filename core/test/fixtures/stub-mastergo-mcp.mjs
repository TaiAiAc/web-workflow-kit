// MasterGo（vibe-mcp）MCP 服务的桩：返回格式取自 vibe-mcp 1.0.31 对真实 MasterGo 文件的输出。
// STUB_MCP_ERROR 设置时，get_selection_node 返回“❌ 没有选中图层”。
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const VARIABLES = "✅ 当前文件变量已获取\n\n摘要：\n{\n  \"variables\": 2\n}\n\n完整数据：\n"
  + JSON.stringify({ documentName: "OA桌面端", variables: [
    { id: "1", collection: "集合", name: "品牌蓝400-常规", type: "COLOR", mode: [{ name: "模式 1", value: "#0370ed" }] },
    { id: "2", collection: "集合", name: "圆角", type: "FLOAT", mode: [{ name: "亮", value: 4 }, { name: "暗", value: 6 }] },
  ] }) + "\n\n已落盘: C:\\Users\\x\\.mgmcp\\variable.json"

const projectDir = { type: "object", properties: { projectDir: { type: "string" } }, required: ["projectDir"] }
const server = new Server({ name: "stub-mastergo", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "get_selection_node", description: "选中图层", inputSchema: projectDir },
  { name: "get_variables", description: "文件变量", inputSchema: projectDir },
  { name: "write_component", description: "写组件", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
] }))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const dir = params.arguments?.projectDir
  const text = params.name === "get_variables"
    ? VARIABLES
    : process.env.STUB_MCP_ERROR
      ? "❌ 没有选中图层：请先在 MasterGo 中选中一个图层"
      : `✅ 成功获取节点代码\n- 节点: 消息提醒 (499:108850)\n- 项目: ${dir}\n\n代码内容：\n\n<ui-component data-node-id="499:108850" style="width: 340px"></ui-component>\n`
  return { content: [{ type: "text", text }] }
})
await server.connect(new StdioServerTransport())
