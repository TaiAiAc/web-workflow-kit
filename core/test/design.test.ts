// 设计稿：vibe-mcp 输出的解析，以及经真实 MCP stdio 协议读取（对端是桩）。
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../src/config.ts"
import { decode, loadDesign } from "../src/design.ts"
import { tempDir } from "./helpers.ts"

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-mastergo-mcp.mjs")

// 以下样本取自 vibe-mcp 1.0.31 对真实 MasterGo 文件的返回
const VARIABLES = "✅ 当前文件变量已获取\n\n摘要：\n{\n  \"variables\": 2\n}\n\n完整数据：\n"
  + "{\"documentName\": \"OA桌面端\", \"variables\": ["
  + "{\"id\": \"1\", \"collection\": \"集合\", \"name\": \"品牌蓝400-常规\", \"type\": \"COLOR\", \"mode\": [{\"name\": \"模式 1\", \"value\": \"#0370ed\"}]},"
  + "{\"id\": \"2\", \"collection\": \"集合\", \"name\": \"圆角\", \"type\": \"FLOAT\", \"mode\": [{\"name\": \"亮\", \"value\": 4}, {\"name\": \"暗\", \"value\": 6}]}]}"
  + "\n\n已落盘: C:\\Users\\x\\.mgmcp\\variable.json\n索引: C:\\Users\\x\\.mgmcp\\catalog.json"
const SELECTION = "✅ 成功获取节点代码\n- 节点: 消息提醒 (499:108850)\n- 父容器方向: row\n\n代码内容：\n\n"
  + "<ui-component data-node-id=\"499:108850\" style=\"width: 340px\"></ui-component>\n"

describe("解析 vibe-mcp 输出", () => {
  it("变量表：忽略 JSON 后面的说明并压缩成 tokens", () => {
    const out = decode("get_variables", [{ type: "text", text: VARIABLES }]) as any
    assert.equal(out.documentName, "OA桌面端")
    assert.equal(out.tokens["品牌蓝400-常规"], "#0370ed")
    assert.deepEqual(out.tokens["圆角"], { 亮: 4, 暗: 6 })
  })

  it("选中图层：摘要与代码分开", () => {
    const out = decode("get_selection_node", [{ type: "text", text: SELECTION }]) as any
    assert.ok(out.summary.includes("节点: 消息提醒 (499:108850)"))
    assert.ok(out.code.startsWith("<ui-component"))
  })

  it("❌ 开头的结果当作错误", () => {
    assert.throws(() => decode("get_selection_node", [{ type: "text", text: "❌ 没有选中图层：请先选中" }]), /没有选中图层/)
  })
})

describe("读取设计稿", () => {
  function project(extra: Record<string, unknown> = {}) {
    const root = tempDir()
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({
      design: { enabled: true, max_chars: 4000, mcp: { command: process.execPath, args: [STUB], url: null, env_keys: [] }, ...extra },
    }))
    return root
  }

  it("本地 .json：超出预算截断", async () => {
    const root = tempDir()
    writeFileSync(join(root, "login.json"), JSON.stringify({ page: "登录", blob: "x".repeat(30000) }))
    const out = await loadDesign("login.json", loadConfig(root)) as any
    assert.equal(out.truncated, true)
    await assert.rejects(loadDesign("nope.png", loadConfig(root)), /neither a local \.json file nor 'mastergo'/)
  })

  it("MasterGo：经 MCP 取选中图层与变量，每个工具分别预算", async () => {
    const root = project()
    const out = await loadDesign("mastergo", loadConfig(root)) as any
    assert.ok(out.get_selection_node.summary.includes(`项目: ${loadConfig(root).projectRoot}`)) // projectDir 传给了工具
    assert.equal(out.get_variables.tokens["品牌蓝400-常规"], "#0370ed")
  })

  it("MasterGo：没选中图层时报错，不把错误当设计稿", async () => {
    const root = project()
    const old = process.env.STUB_MCP_ERROR
    process.env.STUB_MCP_ERROR = "1"
    try {
      await assert.rejects(loadDesign("mastergo", loadConfig(root)), /MasterGo get_selection_node: ❌ 没有选中图层/)
    }
    finally {
      if (old === undefined)
        delete process.env.STUB_MCP_ERROR
      else process.env.STUB_MCP_ERROR = old
    }
  })

  it("MasterGo：只支持只读工具、关闭时提示开启", async () => {
    await assert.rejects(loadDesign("mastergo", loadConfig(project({ tools: ["write_component"] }))), /needs arguments \["path"\]/)
    await assert.rejects(loadDesign("mastergo", loadConfig(project({ tools: ["get_nothing"] }))), /tool 'get_nothing' not found/)
    await assert.rejects(loadDesign("mastergo", loadConfig(project({ enabled: false }))), /design\.enabled=true/)
  })
})
