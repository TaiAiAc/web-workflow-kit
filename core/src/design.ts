// 设计稿读取（与 Python 版 design.py 一致）。两种来源：
// - 本地导出的 `.json` 文件路径；
// - `mastergo` / `mastergo:selection`：经 @mastergo/vibe-mcp 读取本机 MasterGo 客户端里**当前选中的图层**和文件变量。
//   vibe-mcp 连的是本地 MasterGo 服务（默认 http://localhost:30678），不按链接取稿，所以先在 MasterGo 里选中图层再跑。
//   需要在 agent.config.json 打开 design.enabled。
import { existsSync, readFileSync } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { absoluteIn, type Config } from "./config.ts"
import { matchBracket } from "./llm.ts"
import { which } from "./proc.ts"

const MASTERGO_REFS = new Set(["mastergo", "mastergo:selection", "selection"])
const FULL_DATA_MARK = "完整数据："
const CODE_MARK = "代码内容："

type Json = Record<string, any>

function clip(data: unknown, maxChars: number): Json {
  const text = JSON.stringify(data)
  if (text.length <= maxChars)
    return data && typeof data === "object" && !Array.isArray(data) ? data as Json : { data }
  return { truncated: true, raw: text.slice(0, maxChars) }
}

/** 按工具分别预算：变量表很长时不能把选中图层也一起截没。 */
function clipEach(data: Json, maxChars: number): Json {
  const share = Math.max(1000, Math.floor(maxChars / Math.max(1, Object.keys(data).length)))
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, clip(v, share)]))
}

/** 变量表原样太长（id/collection 每条都重复）：压成 {变量名: 值}，多模式时 {变量名: {模式: 值}}。 */
export function compactVariables(data: unknown): unknown {
  const d = data as Json
  if (!d || typeof d !== "object" || !Array.isArray(d.variables))
    return data
  const tokens: Json = {}
  for (const v of d.variables) {
    const modes = Object.fromEntries((v.mode ?? []).filter((m: unknown) => m && typeof m === "object").map((m: Json) => [m.name, m.value]))
    const values = Object.values(modes)
    tokens[v.name ?? v.id] = values.length === 1 ? values[0] : modes
  }
  return { documentName: d.documentName, tokens }
}

/** “✅ 成功获取节点代码 … 代码内容：<html>”：摘要和代码分开，给 Spec 干净的标记。 */
export function splitSelection(text: string): unknown {
  const i = text.indexOf(CODE_MARK)
  if (i < 0)
    return text
  const summary = text.slice(0, i).split(/\r?\n/).map(l => l.replace(/^[-\s]+/, "").trim())
  return { summary: summary.filter(l => l && !l.startsWith("✅")), code: text.slice(i + CODE_MARK.length).trim() }
}

const POSTPROCESS: Record<string, (d: unknown) => unknown> = { get_variables: compactVariables }

/** MCP 工具返回内容块。vibe-mcp 的格式是“✅ 摘要 … 完整数据：{json}”，失败时以 ❌ 开头。 */
export function decode(name: string, content: unknown): unknown {
  let result = content
  if (Array.isArray(result))
    result = result.map(b => (b && typeof b === "object" ? (b as Json).text ?? "" : String(b))).filter(Boolean).join("\n")
  if (typeof result !== "string")
    return result
  const text = result.trim()
  if (text.startsWith("❌")) // 例如没选中图层：必须拦下，否则错误文案会被当成设计稿喂给 Spec
    throw new Error(`MasterGo ${name}: ${text}`)
  const i = text.indexOf(FULL_DATA_MARK)
  if (i >= 0) {
    const body = text.slice(i + FULL_DATA_MARK.length).trim()
    // JSON 后面还跟着“已落盘: …”之类的说明，只取开头那个值
    const end = matchBracket(body, 0)
    if (end >= 0) {
      try {
        return (POSTPROCESS[name] ?? (d => d))(JSON.parse(body.slice(0, end + 1)))
      }
      catch {}
    }
    return body
  }
  return splitSelection(text)
}

async function viaMcp(cfg: Config): Promise<Json> {
  const dcfg = cfg.get("design")
  const mcp = dcfg.mcp ?? {}
  const env = cfg.childEnv()
  // 不传 env 时 MCP SDK 只给子进程一小撮白名单变量，npx 的代理和 shim 配置会丢，表现为卡死
  for (const k of mcp.env_keys ?? []) {
    const v = cfg.secret(k)
    if (v)
      env[k] = v
  }
  const transport = new StdioClientTransport({
    command: which(mcp.command, env) ?? mcp.command, // Windows 上 npx 是 npx.cmd
    args: mcp.url ? [...mcp.args, `--url=${mcp.url}`] : [...mcp.args],
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")),
    cwd: cfg.projectRoot,
    stderr: "pipe",
  })
  const client = new Client({ name: "web-workflow-kit", version: "0.1.0" })
  const timeout = Number(dcfg.timeout_sec ?? 120) * 1000
  try {
    await client.connect(transport, { timeout })
    const { tools } = await client.listTools(undefined, { timeout })
    const byName = new Map(tools.map(t => [t.name, t]))
    // vibe-mcp 的读取类工具都要 projectDir（素材落盘的目标项目）
    const args = { projectDir: cfg.projectRoot }
    const out: Json = {}
    for (const name of dcfg.tools ?? ["get_selection_node", "get_variables"]) {
      const tool = byName.get(name)
      if (!tool)
        throw new Error(`MasterGo MCP tool '${name}' not found; available: ${[...byName.keys()].sort().join(", ")}`)
      const missing = (tool.inputSchema?.required ?? []).filter(a => !(a in args))
      if (missing.length)
        throw new Error(`MasterGo MCP tool '${name}' needs arguments ${JSON.stringify(missing)}; only read-only tools are supported`)
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout })
      out[name] = decode(name, r.content)
    }
    return out
  }
  finally {
    await client.close().catch(() => {})
  }
}

export async function loadDesign(ref: string | null | undefined, cfg: Config): Promise<Json | null> {
  if (!ref)
    return null
  const maxChars = Number(cfg.get("design").max_chars ?? 20000)
  if (MASTERGO_REFS.has(ref.trim().toLowerCase())) {
    if (!cfg.get("design").enabled)
      throw new Error("MasterGo design reading is off; set design.enabled=true in agent.config.json")
    return clipEach(await viaMcp(cfg), maxChars)
  }
  const path = absoluteIn(cfg.projectRoot, ref)
  if (path.endsWith(".json") && existsSync(path))
    return clip(JSON.parse(readFileSync(path, "utf8")), maxChars)
  throw new Error(`design ref ${JSON.stringify(ref)} is neither a local .json file nor 'mastergo'`)
}
