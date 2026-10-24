// vision：ACP 发图片块、不支持图片时退到 CLI、缓存、01 的拼装与校验、开工预检（都用桩，不调模型）。
import assert from "node:assert/strict"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
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

/** 临时设环境变量（桩靠它切换行为），用完还原 */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  Object.assign(process.env, vars)
  try {
    return await fn()
  }
  finally {
    for (const k of Object.keys(vars))
      delete process.env[k]
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

  it("backend=codex_cli 直接走 CLI，带上模型；CLI 失败时报出 stderr", async () => {
    const { cfg, docDir, img } = setup({ backend: "codex_cli", model: "gpt-x" })
    const r = await analyzeImages(cfg, { images: [img("a.png", [8])], requirement: "x", docDir })
    assert.match(r.text, /model=gpt-x/)
    const other = setup({ backend: "codex_cli" })
    await assert.rejects(withEnv({ FAKE_CODEX_FAIL: "1" }, () =>
      analyzeImages(other.cfg, { images: [other.img("a.png", [9])], requirement: "x", docDir: other.docDir })), /退出码 2：model not available/)
  })

  it("只收图片；roles.vision.agent 不是 codex 就拒绝", async () => {
    const { cfg, docDir, img } = setup()
    await assert.rejects(analyzeImages(cfg, { images: [img("a.pdf", [1])], requirement: "x", docDir }), /只支持图片/)
    cfg.workflow.raw.roles.vision.agent = "claude"
    await assert.rejects(analyzeImages(cfg, { images: [img("b.png", [1])], requirement: "x", docDir }), /只支持 codex/)
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
