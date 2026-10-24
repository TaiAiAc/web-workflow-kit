// vision：ACP 发图片块、不支持图片时退到 CLI、缓存、01 的拼装与校验、开工预检（都用桩，不调模型）。
import assert from "node:assert/strict"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { ACPAgent } from "../src/acp.ts"
import { loadConfig } from "../src/config.ts"
import { parseDoc } from "../src/docs.ts"
import { analyzeImages, cleanBody, visionPreflight } from "../src/vision.ts"
import { tempDir } from "./helpers.ts"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const STUB = join(FIXTURES, "stub-vision-acp.mjs")
const FAKE_CLI = join(FIXTURES, "fake-codex-cli.mjs")

/** 配置好桩的项目：codex 预设的 ACP 命令指向桩，CLI 指向假 codex */
function setup(opts: { backend?: string, model?: string } = {}) {
  const root = tempDir()
  const cfg = loadConfig(root)
  cfg.raw.coding_agents.codex.command = [process.execPath, STUB]
  Object.assign(cfg.workflow.raw.vision, { cli_command: [process.execPath, FAKE_CLI], ...(opts.backend ? { backend: opts.backend } : {}), ...(opts.model ? { model: opts.model } : {}) })
  const img = (name: string, bytes: number[]) => {
    const p = join(root, name)
    writeFileSync(p, Buffer.from(bytes))
    return p
  }
  return { cfg, docDir: join(root, "docs", "wwk", "20261024-login"), img }
}

/** 临时设环境变量（桩靠它切换行为，也会临时改 PATH），用完恢复原值 */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  }
  finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  }
}

describe("vision", () => {
  it("走 ACP：图片按 image 块发出；01 由这里拼好、能过校验；素材存进文档目录", async () => {
    const { cfg, docDir, img } = setup()
    const r = await analyzeImages(cfg, { images: [img("a.png", [1, 2]), img("b.JPG", [3])], requirement: "做登录页", docDir })
    assert.equal(r.backend, "codex_acp")
    assert.equal(r.cached, false)
    assert.deepEqual(r.lint.errors, [])
    assert.match(r.text, /ACP 收到 images=2 mime=image\/png,image\/jpeg base64=true/)
    const doc = parseDoc(r.text)
    assert.deepEqual([doc.front.stage, doc.front.owner], ["discovery", "vision"])
    assert.deepEqual(doc.machine!.sources.map((s: any) => [s.type, s.ref]), [["image", "a.png"], ["image", "b.JPG"]])
    assert.deepEqual(doc.machine!.assets.map((a: any) => a.purpose), ["图1", "图2"])
    assert.equal(readdirSync(join(docDir, "assets")).length, 2)
  })

  it("同样的图和需求命中缓存；需求变了就重新看", async () => {
    const { cfg, docDir, img } = setup()
    const input = { images: [img("a.png", [1, 2])], requirement: "做登录页", docDir }
    await analyzeImages(cfg, input)
    const again = await analyzeImages(cfg, input)
    assert.equal(again.cached, true)
    assert.deepEqual(again.lint.errors, [])
    assert.equal((await analyzeImages(cfg, { ...input, requirement: "做注册页" })).cached, false)
    assert.equal((await analyzeImages(cfg, { ...input, question: "按钮是什么颜色？" })).cached, false)
  })

  it("适配器没声明支持图片：不悄悄丢图，改走 CLI（只读沙箱、prompt 在 -i 前面）", async () => {
    const { cfg, docDir, img } = setup()
    const logs: string[] = []
    const r = await withEnv({ STUB_NO_IMAGE: "1" }, () =>
      analyzeImages(cfg, { images: [img("a.png", [7])], requirement: "x", docDir }, { log: l => logs.push(l) }))
    assert.equal(r.backend, "codex_cli")
    assert.match(r.text, /CLI 收到 images=1 sandbox=read-only model=default prompt_before_images=true/)
    assert.ok(logs.some(l => l.includes("适配器不支持图片输入")))
  })

  it("ACP 回 JSON-RPC 错误（如额度用完）：返回出错原因、不让进程崩，vision 改走 CLI", async () => {
    const { cfg, docDir, img } = setup()
    const agent = new ACPAgent({ agent: "stub", command: [process.execPath, STUB], timeoutSec: 30 })
    const r = await withEnv({ STUB_PROMPT_ERROR: "1" }, () => agent.run("hi", tempDir()))
    assert.equal(r.stopReason, "error")
    assert.match(r.text, /Internal error（Quota exceeded\.）/)
    await new Promise(res => setTimeout(res, 300)) // 之前这里会因未处理的拒绝让整个进程退出
    const v = await withEnv({ STUB_PROMPT_ERROR: "1" }, () => analyzeImages(cfg, { images: [img("q.png", [4])], requirement: "x", docDir }))
    assert.equal(v.backend, "codex_cli")
  })

  it("backend=codex_cli 直接走 CLI，带上模型；CLI 失败时报出 stderr", async () => {
    const { cfg, docDir, img } = setup({ backend: "codex_cli", model: "gpt-x" })
    const r = await analyzeImages(cfg, { images: [img("a.png", [8])], requirement: "x", docDir })
    assert.match(r.text, /model=gpt-x/)
    const other = setup({ backend: "codex_cli" })
    await assert.rejects(withEnv({ FAKE_CODEX_FAIL: "1" }, () =>
      analyzeImages(other.cfg, { images: [other.img("a.png", [9])], requirement: "x", docDir: other.docDir })), /退出码 2：model not available/)
  })

  it("只收图片；看图只能选 codex / claude", async () => {
    const { cfg, docDir, img } = setup()
    await assert.rejects(analyzeImages(cfg, { images: [img("a.pdf", [1])], requirement: "x", docDir }), /只支持图片/)
    cfg.workflow.raw.roles.vision.agent = "dsh"
    await assert.rejects(analyzeImages(cfg, { images: [img("b.png", [1])], requirement: "x", docDir }), /只支持 codex \/ claude/)
  })

  it("选 Claude Code 看图：只读启动，图片文件就在它的工作目录里", async () => {
    const { cfg, docDir, img } = setup()
    // 假 claude：报告收到的权限模式和工作目录里的图片，按 claude -p --output-format json 的格式输出
    const bin = tempDir()
    const fake = join(bin, process.platform === "win32" ? "claude.cmd" : "claude")
    const script = join(bin, "fake-claude.mjs")
    writeFileSync(script, `import { readdirSync } from "node:fs"
const a = process.argv.slice(2); const mode = a[a.indexOf("--permission-mode") + 1]
const imgs = readdirSync(".").filter(f => f.startsWith("image-")).join(",")
console.log(JSON.stringify({ result: "## 概览\\n\\n登录页。mode=" + mode + " images=" + imgs + "\\n\\n## 不确定的地方\\n\\n无", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }))`)
    writeFileSync(fake, process.platform === "win32" ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
    const r = await withEnv({ PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` }, () =>
      analyzeImages(cfg, { images: [img("a.png", [1]), img("b.png", [2])], requirement: "x", docDir }, { agent: "claude" }))
    assert.equal(r.backend, "claude_cli")
    assert.match(r.text, /mode=default images=image-1\.png,image-2\.png/)
    assert.deepEqual(r.lint.errors, [])
  })

  it("模型多写的代码块、front-matter、machine 块都去掉", () => {
    assert.equal(cleanBody("```markdown\n## 概览\n\n登录页\n```"), "## 概览\n\n登录页")
    assert.equal(cleanBody("---\nstage: x\n---\n## 概览\n\n正文\n\n```yaml\nmachine:\n  a: 1\n```\n"), "## 概览\n\n正文")
  })

  it("开工预检：codex 可用才放行", () => {
    const { cfg } = setup()
    assert.equal(visionPreflight(cfg)[0], true)
    cfg.raw.coding_agents.codex.command = ["definitely-not-installed-acp"]
    cfg.workflow.raw.vision.cli_command = ["definitely-not-installed-codex"]
    const [ok, why] = visionPreflight(cfg)
    assert.equal(ok, false)
    assert.match(why, /都不可用/)
    cfg.workflow.raw.vision.backend = "codex_cli"
    assert.match(visionPreflight(cfg)[1], /未找到 definitely-not-installed-codex/)
    cfg.workflow.raw.roles.vision.agent = "dsh"
    assert.match(visionPreflight(cfg)[1], /只支持 codex/)
  })

  it("校验不过的结果（如留了占位词）照样返回、标出问题，但不进缓存", async () => {
    const { cfg, docDir, img } = setup({ backend: "codex_cli" })
    const input = { images: [img("a.png", [5])], requirement: "x", docDir }
    const bad = await withEnv({ FAKE_CODEX_PLACEHOLDER: "1" }, () => analyzeImages(cfg, input))
    assert.equal(bad.lint.ok, false)
    assert.match(bad.lint.errors.join(), /占位符.*待定/)
    assert.ok(!existsSync(join(cfg.stateDir, "cache", "vision")))
    const good = await analyzeImages(cfg, input)
    assert.equal(good.cached, false)
    assert.equal(good.lint.ok, true)
  })
})
