// vision（看图，第二阶段）：图片 + 需求 → 01 设计分析（B 模式的取材）。不写代码。
// - 只读：在只放了图片副本的临时目录里跑，碰不到项目文件；ACP 权限只放 read / search / think；
// - 默认走 codex ACP（image 块）；适配器不支持图片、起不来或出错时退到 codex CLI（-i 图片，--sandbox read-only）；
// - 正文由模型写；front-matter 和 machine 块在这里拼：来源、素材是事实，不让模型编；
// - 按图片内容 + 需求 + 补充问题缓存正文，同样的输入不重复花 token。
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import YAML from "yaml"
import { ACPAgent, IMAGE_UNSUPPORTED, type PromptImage } from "./acp.ts"
import { assertAgentOptions } from "./agent-options.ts"
import { END_TURN } from "./agent-result.ts"
import { ClaudeCodeCLI } from "./agents.ts"
import { type Config, prompt, render, writeText } from "./config.ts"
import { ASSET_EXTS, type LintResult, lintDoc, storeAsset } from "./docs.ts"
import { run, which } from "./proc.ts"

export type VisionBackend = "codex_acp" | "codex_cli" | "claude_cli"

/** 能看图的 agent：Codex（ACP 图片块 / CLI -i）、Claude Code（只读地用读取工具看图片文件） */
export const VISION_AGENTS = ["codex", "claude"] as const

export interface VisionInput {
  /** 图片路径（截图 / 设计稿导出图），按顺序编号为 图1、图2…… */
  images: string[]
  requirement: string
  /** 本次运行的入库文档目录：素材存进它的 assets/，01 的校验也按它查 */
  docDir: string
  /** product 的一次补充问题（可选）：带上它重新分析 */
  question?: string
}

export interface VisionResult {
  /** 完整的 01 文档 */
  text: string
  backend: VisionBackend
  cached: boolean
  lint: LintResult
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
}
// 改了提示词或拼装方式就换版本号，旧缓存自然失效
const CACHE_VERSION = 1

interface VisionSettings {
  agent: string
  backend: VisionBackend
  model: string | null
  effort: string | null
  timeoutSec: number
  /** ACP 适配器命令：codex 预设里的 command，没有就用内置适配器 */
  acpCommand: string[] | null
  cliCommand: string[]
  env: NodeJS.ProcessEnv
}

function settings(cfg: Config, override?: string | null, model?: string | null, effort?: string | null): VisionSettings {
  const wf = cfg.workflow.raw
  const agent = override || wf.roles?.vision?.agent
  if (!(VISION_AGENTS as readonly string[]).includes(agent))
    throw new Error(`看图目前只支持 ${VISION_AGENTS.join(" / ")}（当前是 ${agent}）`)
  const v = wf.vision ?? {}
  const preset = cfg.raw.coding_agents?.[agent] ?? {}
  const selectedModel = model || (agent === "claude" ? preset.model ?? null : v.model ?? null)
  const selectedEffort = effort || preset.effort || null
  assertAgentOptions({ backend: agent === "claude" ? "claude_cli" : "acp", agent, ...preset }, selectedModel, selectedEffort)
  return {
    agent,
    backend: agent === "claude" ? "claude_cli" : v.backend === "codex_cli" ? "codex_cli" : "codex_acp",
    model: selectedModel,
    effort: selectedEffort,
    timeoutSec: Number(v.timeout_sec ?? 300),
    acpCommand: preset.command ?? null,
    cliCommand: Array.isArray(v.cli_command) && v.cli_command.length ? v.cli_command : ["codex"],
    env: { ...cfg.childEnv(), ...(preset.env ?? {}) },
  }
}

/** 开工预检：B 模式（图片 + 文字）要求看图的 agent 可用，否则拒绝开工。返回 [可用, 说明]。 */
export function visionPreflight(cfg: Config, override?: string | null): [boolean, string] {
  let s: VisionSettings
  try {
    s = settings(cfg, override)
  }
  catch (e) {
    return [false, (e as Error).message]
  }
  if (s.backend === "claude_cli") {
    const claude = which("claude", s.env)
    return claude ? [true, `Claude Code：${claude}`] : [false, "未找到 claude 命令：看图需要 Claude Code"]
  }
  const cli = which(s.cliCommand[0], s.env)
  if (s.backend === "codex_cli")
    return cli ? [true, `codex CLI：${cli}`] : [false, `未找到 ${s.cliCommand[0]} 命令：看图需要 Codex CLI`]
  const adapter = s.acpCommand ? which(s.acpCommand[0], s.env) : which("codex-acp", s.env) ?? which("npx", s.env)
  if (adapter)
    return [true, `codex ACP：${adapter}${cli ? "（CLI 作退路）" : ""}`]
  return cli ? [true, `codex ACP 适配器不可用，改用 codex CLI：${cli}`] : [false, "codex ACP 适配器和 codex CLI 都不可用：看图需要 Codex"]
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex")

/** 看图出 01：素材先存进文档目录，再跑模型（或命中缓存），最后拼成完整文档并校验。 */
export async function analyzeImages(
  cfg: Config,
  input: VisionInput,
  opts: { log?: (line: string) => void, agent?: string | null, model?: string | null, effort?: string | null } = {},
): Promise<VisionResult> {
  const log = opts.log ?? (() => {})
  if (!input.images.length)
    throw new Error("vision 至少需要一张图片")
  for (const p of input.images) {
    if (!existsSync(p))
      throw new Error(`图片不存在：${p}`)
    if (!ASSET_EXTS.includes(extname(p).toLowerCase()))
      throw new Error(`只支持图片（${ASSET_EXTS.join(" ")}）：${p}`)
  }
  const s = settings(cfg, opts.agent, opts.model, opts.effort)
  const stored = input.images.map(p => ({ src: p, ...storeAsset(input.docDir, p) }))

  const key = sha256(JSON.stringify({ v: CACHE_VERSION, images: stored.map(a => a.hash), requirement: input.requirement, question: input.question ?? "", agent: s.agent, model: s.model, effort: s.effort }))
  const cacheFile = join(cfg.stateDir, "cache", "vision", `${key.slice(0, 24)}.md`)
  let body: string
  let backend: VisionBackend = s.backend
  let cached = false
  if (existsSync(cacheFile)) {
    body = readFileSync(cacheFile, "utf8")
    cached = true
    log(`[vision] 命中缓存（${stored.length} 张图）`)
  }
  else {
    ;({ body, backend } = await look(s, input, stored.map(a => a.src), log))
  }

  const text = assemble(cfg, body, stored)
  const lint = lintDoc("01", text, { docDir: input.docDir })
  if (!cached && lint.ok)
    writeText(cacheFile, body) // 只缓存合格的结果
  return { text, backend, cached, lint }
}

/** 真正调模型：ACP 优先，出错退到 CLI。临时目录里只有图片副本，用完即删。 */
async function look(s: VisionSettings, input: VisionInput, images: string[], log: (line: string) => void): Promise<{ body: string, backend: VisionBackend }> {
  const work = mkdtempSync(join(tmpdir(), "wwk-vision-"))
  try {
    const copies = images.map((p, i) => {
      const dst = join(work, `image-${i + 1}${extname(p).toLowerCase()}`)
      copyFileSync(p, dst)
      return dst
    })
    const text = render(prompt("vision-prompt.md"), {
      image_count: String(copies.length),
      requirement: input.requirement.trim() || "（没有文字需求，只看图）",
      question: input.question ? `产品的补充问题（请在正文里一并回答）：\n\n${input.question}` : "",
    })
    if (s.backend === "claude_cli") { // 图片在临时目录里，Claude Code 只读地用读取工具看
      log(`[vision] 经 Claude Code 看 ${copies.length} 张图…`)
      const files = copies.map((p, i) => `- 图${i + 1}：${basename(p)}`).join("\n")
      const agent = new ClaudeCodeCLI({ model: s.model, effort: s.effort, permissionMode: "default", timeoutSec: s.timeoutSec, env: s.env })
      const r = await agent.run(`${text}\n\n## 图片文件（就在当前目录，请用读取工具逐个查看）\n\n${files}`, work)
      if (r.stopReason !== END_TURN || !r.text.trim())
        throw new Error(`vision 失败：Claude Code stop_reason=${r.stopReason}：${r.text.slice(-300)}`)
      return { body: cleanBody(r.text), backend: "claude_cli" }
    }
    let acpError: string | null = null
    if (s.backend === "codex_acp") {
      log(`[vision] 经 codex ACP 看 ${copies.length} 张图…`)
      const images64: PromptImage[] = copies.map(p => ({ data: readFileSync(p).toString("base64"), mimeType: MIME[extname(p)] }))
      const agent = new ACPAgent({
        agent: "codex", command: s.acpCommand, model: s.model, effort: s.effort, allowKinds: ["read", "search", "think"], protectedPaths: ["*"], timeoutSec: s.timeoutSec, env: s.env,
      })
      const r = await agent.run(text, work, images64)
      if (r.stopReason === END_TURN && r.text.trim())
        return { body: cleanBody(r.text), backend: "codex_acp" }
      acpError = r.text.includes(IMAGE_UNSUPPORTED) ? "适配器不支持图片输入" : `stop_reason=${r.stopReason}：${r.text.slice(-300)}`
      log(`[vision] ACP 没成功（${acpError}），改用 codex CLI`)
    }
    const cli = which(s.cliCommand[0], s.env)
    if (!cli)
      throw new Error(`vision 失败：${acpError ? `ACP ${acpError}；` : ""}未找到 ${s.cliCommand[0]} 命令`)
    const out = join(work, "last-message.md")
    // prompt 要放在 -i 前面：-i 能接多个文件，紧跟其后的参数会被当成图片路径
    const args = [...s.cliCommand.slice(1), "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never",
      "-o", out, ...(s.model ? ["-m", s.model] : []), ...(s.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(s.effort)}`] : []),
      text, ...copies.flatMap(p => ["-i", p])]
    if (s.backend === "codex_cli")
      log(`[vision] 经 codex CLI 看 ${copies.length} 张图…`)
    const r = await run(cli, args, { cwd: work, env: s.env, timeoutMs: s.timeoutSec * 1000 })
    if (r.timedOut)
      throw new Error(`vision 失败：codex CLI 超过 ${s.timeoutSec}s`)
    const answer = existsSync(out) ? readFileSync(out, "utf8") : r.stdout
    if (r.code !== 0 || !answer.trim())
      throw new Error(`vision 失败：codex CLI 退出码 ${r.code}${r.stderr.trim() ? `：${r.stderr.trim().slice(-500)}` : ""}`)
    return { body: cleanBody(answer), backend: "codex_cli" }
  }
  finally {
    try { // Windows 上刚结束的 agent 进程可能还占着目录：多试几次，删不掉就留给系统清临时目录，不影响结果
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
    catch {}
  }
}

/** 模型偶尔会把正文包进代码块、带上 front-matter 或自己写 machine 块：都去掉，machine 块由我们拼。 */
export function cleanBody(text: string): string {
  let t = text.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t)
  if (fenced)
    t = fenced[1].trim()
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  t = t.replace(/```ya?ml\s*\n\s*machine\s*:[\s\S]*?```/g, "")
  return t.trim()
}

function assemble(cfg: Config, body: string, stored: { src: string, path: string, hash: string }[]): string {
  const front = {
    stage: "discovery",
    owner: "vision",
    status: "approved",
    version: 1,
    inputs: [],
    config_hash: sha256(JSON.stringify(cfg.workflow.raw)).slice(0, 12),
    generated_at: new Date().toISOString(),
  }
  const machine = {
    sources: stored.map(a => ({ type: "image", ref: basename(a.src), hash: a.hash })),
    assets: stored.map((a, i) => ({ path: a.path, kind: "image", hash: a.hash, purpose: `图${i + 1}` })),
    open_questions: [],
  }
  return `---\n${YAML.stringify(front)}---\n\n# 设计分析\n\n${body}\n\n\`\`\`yaml\n${YAML.stringify({ machine })}\`\`\`\n`
}
