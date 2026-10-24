// 文档阶段：取材与需求、技术设计、文档复核（含仲裁）、产品验收，以及编码用 02 / 03、05 自测、验收打回重做。
// agent 都是按角色排好回复的假 agent，门禁按脚本给结果，不调任何模型。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"
import YAML from "yaml"
import { type Agent, type AgentResult, END_TURN } from "../src/agents.ts"
import { lintDoc, parseDoc, storeAsset } from "../src/docs.ts"
import { runPipeline } from "../src/graph.ts"
import { Metrics } from "../src/metrics.ts"
import { assembleDoc, extractBody } from "../src/stages.ts"
import type { VisionInput, VisionResult } from "../src/vision.ts"
import { FAIL, makeDeps, PASS, tempDir } from "./helpers.ts"

type Json = Record<string, any>
type Reply = string | ((prompt: string) => string)

/** 按顺序回复的假 agent，记下收到的 prompt */
class Scripted implements Agent {
  readonly calls: string[] = []
  readonly replies: Reply[]
  constructor(...replies: Reply[]) {
    this.replies = replies
  }

  async run(prompt: string): Promise<AgentResult> {
    this.calls.push(prompt)
    const r = this.replies.shift()
    if (r === undefined)
      throw new Error(`假 agent 被多调了一次：${prompt.slice(0, 80)}`)
    return { stopReason: END_TURN, text: typeof r === "function" ? r(prompt) : r }
  }
}

const doc = (body: string, machine: Json) => `${body}\n\n\`\`\`yaml\n${YAML.stringify({ machine })}\`\`\``
const SPEC = (opts: { open?: string[] } = {}) => doc("# 需求规格\n\n## 目标\n\n做登录页。", {
  ac: [{ id: "AC-1", statement: "能用手机号登录", priority: "must", verify: "auto" }, { id: "AC-2", statement: "密码错误有提示", priority: "should", verify: "screenshot" }],
  assumptions: [{ id: "A-1", statement: "沿用现有表单组件", risk: "low" }],
  non_goals: [],
  open_questions: opts.open ?? [],
})
const DESIGN = (extra = "") => doc(`# 技术设计\n\n## 方案概述\n\n新增 Login.vue。${extra}`, {
  ac_coverage: { "AC-1": { impl: "src/Login.vue#submit", test: "test/login.test.ts#登录" }, "AC-2": { impl: "src/Login.vue#error", test: "test/login.test.ts#报错" } },
  decisions: [{ id: "D-1", decision: "用现有表单", alternatives: ["手写"], reason: "一致" }],
  touches: ["src/Login.vue"],
  risk: "low",
})
const REVIEW = (verdict: "approved" | "rejected", round: number) => doc("# 复核意见", {
  verdict, round,
  items: verdict === "rejected" ? [{ id: "R-1", ac_ref: "AC-2", doc_ref: "03#逐条实现", issue: "没写报错怎么测", fix_required: true, severity: "major" }] : [],
})
const ACCEPT = (pass: boolean, back: string | null = "implement") => doc("# 验收报告", {
  ac_status: { "AC-1": "pass", "AC-2": pass ? "pass" : "fail" },
  verdict: pass ? "pass" : "fail",
  return_stage: pass ? null : back,
  evidence: ["src/Login.vue#submit"],
})
const SELF_TEST = "改好了。\n\n```yaml\nmachine:\n  ac_status:\n    AC-1: pass\n    AC-2: pass\n  uncovered: []\n  deviates_from_design: false\n```"
const RULING = (verdict: "approve" | "reject") => `仲裁理由。\n\n\`\`\`yaml\nmachine:\n  verdict: ${verdict}\n  reasons: [理由]\n  notes: [顺带补上报错测试]\n\`\`\``

let tmp: string
beforeEach(() => {
  tmp = tempDir()
  execFileSync("git", ["init", "-q"], { cwd: tmp })
})

/** 文档阶段全开的 deps；roles 是各角色的假 agent */
function setup(gates: typeof PASS[], roles: { product: Scripted, tech?: Scripted, arbiter?: Scripted, coder?: Scripted }, vision?: (i: VisionInput) => Promise<VisionResult>) {
  const { deps, cfg } = makeDeps(tmp, gates, { docStages: true })
  deps.coder = roles.coder ?? new Scripted(SELF_TEST, SELF_TEST, SELF_TEST)
  deps.roleAgent = role => ({ agent: (roles as Record<string, Scripted>)[role] ?? new Scripted(), name: role })
  deps.metrics = new Metrics(null)
  deps.agentNames = { coder: "coder", fixer: "fixer" }
  if (vision)
    deps.vision = vision
  return { deps, cfg }
}

describe("文档阶段", () => {
  it("纯文字：01 由代码生成，02 / 03 / 04 / 06 依次产出并过校验，编码直接用 02 + 03", async () => {
    const product = new Scripted(SPEC(), REVIEW("approved", 1), ACCEPT(true))
    const tech = new Scripted(DESIGN())
    const coder = new Scripted(SELF_TEST)
    const { deps } = setup([PASS], { product, tech, coder })
    const s = await runPipeline(deps, "做登录页")
    assert.equal(s.status, "delivered", s.summary)
    assert.deepEqual(Object.keys(s.artifacts).sort(), ["01", "02", "03", "04", "05", "06"])
    for (const id of ["01", "02", "03"] as const)
      assert.ok(s.artifacts[id].includes(join("docs", "wwk")), `${id} 应该在入库目录：${s.artifacts[id]}`)
    assert.ok(s.artifacts["04"].includes(join(".agent", "stages", "doc-review")))
    assert.deepEqual(s.stage_status, { "discovery": "done", "tech-design": "done", "doc-review": "done", "implement": "done", "gate": "done", "acceptance": "done" })
    const d01 = parseDoc(readFileSync(s.artifacts["01"], "utf8"))
    assert.deepEqual([d01.front.owner, d01.machine!.sources[0].type], ["product", "text"])
    // 编码的 prompt：Spec 是 02 + 03，并要求附 05 自测
    assert.match(coder.calls[0], /# 需求规格（02）[\s\S]*# 技术设计（03）/)
    assert.match(coder.calls[0], /## 自测（05）[\s\S]*AC-1: pass/)
    assert.equal(product.calls.length, 3)
    assert.match(product.calls[2], /本次改动的文件/)
  })

  it("校验不过：问题清单交还 agent 重写；连续 3 次不过就熔断", async () => {
    const product = new Scripted(SPEC({ open: ["颜色？"] }), SPEC(), REVIEW("approved", 1), ACCEPT(true))
    const { deps } = setup([PASS], { product, tech: new Scripted(DESIGN()) })
    const s = await runPipeline(deps, "做登录页")
    assert.equal(s.status, "delivered", s.summary)
    assert.match(product.calls[1], /上一次的输出没有通过校验[\s\S]*open_questions 必须清零/)
    const lintRejects = deps.metrics!.events.filter(e => e.kind === "reject" && e.by === "lint")
    assert.equal(lintRejects.length, 1)

    const bad = SPEC({ open: ["?"] })
    const again = setup([], { product: new Scripted(bad, bad, bad) })
    const broken = await runPipeline(again.deps, "做登录页")
    assert.equal(broken.status, "broken")
    assert.match(broken.break_reason, /^DOC_LINT_FAILED: 02 连续 3 次/)
    assert.equal(broken.stage_status.discovery, "failed")
  })

  it("复核打回：技术设计带回应表重写，第二轮通过", async () => {
    const product = new Scripted(SPEC(), REVIEW("rejected", 1), REVIEW("approved", 2), ACCEPT(true))
    const tech = new Scripted(DESIGN(), DESIGN("\n\n| 问题编号 | 怎么改的 |\n| --- | --- |\n| R-1 | 补了报错测试 |"))
    const { deps } = setup([PASS], { product, tech })
    const s = await runPipeline(deps, "做登录页")
    assert.equal(s.status, "delivered", s.summary)
    assert.match(tech.calls[1], /上一版被文档复核打回[\s\S]*回应表/)
    assert.equal(s.doc_round, 2)
    assert.ok(existsSync(join(deps.cfg.stateDir, "stages", "tech-design", "history", "03-tech-design.v1.md"))) // 旧版本留档
  })

  it("复核打回时 03 没写回应表：算校验不过，要求重写", async () => {
    const product = new Scripted(SPEC(), REVIEW("rejected", 1), REVIEW("approved", 2), ACCEPT(true))
    const table = "\n\n| 问题编号 | 怎么改的 |\n| --- | --- |\n| R-1 | 补了 |"
    const tech = new Scripted(DESIGN(), DESIGN(), DESIGN(table))
    const { deps } = setup([PASS], { product, tech })
    const s = await runPipeline(deps, "做登录页")
    assert.equal(s.status, "delivered", s.summary)
    assert.match(tech.calls[2], /回应表里没有回应 R-1/)
  })

  it("复核超过轮次交仲裁：通过就继续（遗留问题带给开发），不通过就熔断并留下仲裁结论", async () => {
    const product = new Scripted(SPEC(), REVIEW("rejected", 1), REVIEW("rejected", 2), ACCEPT(true))
    const table = "\n\n| 问题编号 | 怎么改的 |\n| --- | --- |\n| R-1 | 改了 |"
    const coder = new Scripted(SELF_TEST)
    const { deps } = setup([PASS], { product, tech: new Scripted(DESIGN(), DESIGN(table)), arbiter: new Scripted(RULING("approve")), coder })
    const s = await runPipeline(deps, "做登录页")
    assert.equal(s.status, "delivered", s.summary)
    assert.match(coder.calls[0], /仲裁留给开发的问题[\s\S]*顺带补上报错测试/)

    const p2 = new Scripted(SPEC(), REVIEW("rejected", 1), REVIEW("rejected", 2))
    const r2 = setup([], { product: p2, tech: new Scripted(DESIGN(), DESIGN(table)), arbiter: new Scripted(RULING("reject")) })
    const broken = await runPipeline(r2.deps, "做登录页")
    assert.equal(broken.status, "broken")
    assert.match(broken.break_reason, /^DOC_REVIEW_REJECTED: 仲裁判定技术设计不可用/)
    const rulings = execFileSync("ls", [join(r2.deps.cfg.stateDir, "arbitration")]).toString()
    assert.match(rulings, /-ruling\.md/)
    assert.ok(r2.deps.metrics!.events.some(e => e.kind === "reject" && e.by === "arbiter"))
  })

  it("验收没过：回到编码重做（带上意见、门禁重新计数），第二轮通过；两轮都没过就熔断", async () => {
    const product = new Scripted(SPEC(), REVIEW("approved", 1), ACCEPT(false), ACCEPT(true))
    const coder = new Scripted(SELF_TEST, SELF_TEST)
    // 第一轮门禁失败一次再通过，attempt=1；重做后重新计数
    const { deps } = setup([FAIL, PASS, PASS], { product, tech: new Scripted(DESIGN()), coder })
    const s = await runPipeline(deps, "做登录页")
    assert.equal(s.status, "delivered", s.summary)
    assert.equal(coder.calls.length, 2)
    assert.match(coder.calls[1], /上一轮产品验收没通过[\s\S]*AC-2/)
    assert.equal(s.acceptance_round, 2)
    assert.equal(s.attempt, 0)
    assert.ok(deps.metrics!.events.some(e => e.kind === "reject" && e.by === "acceptance" && e.agent === "coder"))

    const p2 = new Scripted(SPEC(), REVIEW("approved", 1), ACCEPT(false), ACCEPT(false))
    const r2 = setup([PASS, PASS], { product: p2, tech: new Scripted(DESIGN()) })
    const broken = await runPipeline(r2.deps, "做登录页")
    assert.equal(broken.status, "broken")
    assert.match(broken.break_reason, /^ACCEPTANCE_FAILED: 验收 2 轮仍未通过（AC-2）/)
  })

  it("验收打回到技术设计：技术设计 → 复核 → 编码 → 门禁 → 验收重走一遍", async () => {
    const product = new Scripted(SPEC(), REVIEW("approved", 1), ACCEPT(false, "tech-design"), REVIEW("approved", 1), ACCEPT(true))
    const tech = new Scripted(DESIGN(), DESIGN("\n\n改了报错方案。"))
    const coder = new Scripted(SELF_TEST, SELF_TEST)
    const { deps } = setup([PASS, PASS], { product, tech, coder })
    const s = await runPipeline(deps, "做登录页")
    assert.equal(s.status, "delivered", s.summary)
    assert.match(tech.calls[1], /上一轮产品验收的意见/)
    assert.equal(coder.calls.length, 2)
    assert.doesNotMatch(coder.calls[1], /上一轮产品验收没通过/) // 意见给了技术设计，编码不再重复
  })

  it("图片：01 来自 vision；product 可以补问 vision 一次", async () => {
    const img = join(tmp, "shot.png")
    writeFileSync(img, Buffer.from([1, 2, 3]))
    const questions: (string | undefined)[] = []
    const vision = async (input: VisionInput): Promise<VisionResult> => {
      questions.push(input.question)
      const a = storeAsset(input.docDir, input.images[0])
      const text = assembleDoc(deps.cfg, "01", "vision", 1, [], `# 设计分析\n\n## 概览\n\n登录页。${input.question ? "\n\n按钮是蓝色。" : ""}`,
        { sources: [{ type: "image", ref: "shot.png", hash: a.hash }], assets: [{ ...a, kind: "image", purpose: "图1" }], open_questions: [] })
      return { text, backend: "codex_acp", cached: false, lint: lintDoc("01", text, { docDir: input.docDir }) }
    }
    const product = new Scripted(p => (p.includes("【问视觉】") ? "【问视觉】登录按钮是什么颜色？" : SPEC()), SPEC(), REVIEW("approved", 1), ACCEPT(true))
    const { deps } = setup([PASS], { product, tech: new Scripted(DESIGN()) }, vision)
    const s = await runPipeline(deps, "照图做登录页", null, { images: [img] })
    assert.equal(s.status, "delivered", s.summary)
    assert.deepEqual(questions, [undefined, "登录按钮是什么颜色？"])
    assert.doesNotMatch(product.calls[1], /【问视觉】/) // 只有一次机会
    assert.match(readFileSync(s.artifacts["01"], "utf8"), /按钮是蓝色/)
  })

  it("MasterGo：product 根据设计稿数据写 01 正文，来源记为 mastergo", async () => {
    const product = new Scripted("## 概览\n\n登录页设计稿。", SPEC(), REVIEW("approved", 1), ACCEPT(true))
    const { deps } = setup([PASS], { product, tech: new Scripted(DESIGN()) })
    deps.design = async () => ({ selection: { name: "登录页" } })
    const s = await runPipeline(deps, "按设计稿做登录页", "mastergo")
    assert.equal(s.status, "delivered", s.summary)
    assert.match(product.calls[0], /"name": "登录页"/)
    const d01 = parseDoc(readFileSync(s.artifacts["01"], "utf8"))
    assert.deepEqual([d01.machine!.sources[0].type, d01.machine!.sources[0].ref], ["mastergo", "mastergo"])
  })

  it("agent 回复的包装（代码块、front-matter、末尾闲话）都去掉", () => {
    const body = extractBody(`\`\`\`markdown\n---\nstage: x\n---\n# 标题\n\n\`\`\`yaml\nmachine:\n  a: 1\n\`\`\`\n\n以上。\n\`\`\``)
    assert.equal(body, "# 标题\n\n```yaml\nmachine:\n  a: 1\n```")
  })
})
