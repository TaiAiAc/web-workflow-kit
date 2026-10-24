// 文档契约、校验、素材、版本历史与提交路径白名单。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import YAML from "yaml"
import { archiveDoc, type DocId, DOCS, docPath, lintDoc, parseDoc, storeAsset } from "../src/docs.ts"
import { assertCommitAllowed, checkCommitPaths, matches, WhitelistError } from "../src/whitelist.ts"
import { tempDir } from "./helpers.ts"

type Json = Record<string, any>

/** 拼一份文档：front-matter + 正文 + 末尾 machine 块 */
function doc(id: DocId, machine: Json, opts: { front?: Json, body?: string } = {}): string {
  const front = {
    stage: DOCS[id].stage, owner: "product", status: "approved", version: 1,
    inputs: [], config_hash: "abc123", generated_at: "2026-10-24T10:00:00Z", ...opts.front,
  }
  return `---\n${YAML.stringify(front)}---\n\n${opts.body ?? "# 标题\n\n正文。\n"}\n\`\`\`yaml\n${YAML.stringify({ machine })}\`\`\`\n`
}

const SPEC = {
  ac: [
    { id: "AC-1", statement: "能登录", priority: "must", verify: "auto" },
    { id: "AC-2", statement: "错误提示", priority: "should", verify: "screenshot" },
  ],
  assumptions: [{ id: "A-1", statement: "用手机号登录", risk: "low" }],
  non_goals: [],
  open_questions: [],
}
const DESIGN = {
  ac_coverage: { "AC-1": { impl: "src/login.ts#submit", test: "test/login.test.ts#登录" }, "AC-2": { impl: "src/login.ts#error", test: "test/login.test.ts#错误" } },
  decisions: [{ id: "D-1", decision: "用表单组件", alternatives: ["手写"], reason: "现成" }],
  touches: ["src/login.ts"],
  risk: "low",
}
const ctx = () => ({ others: { "02": parseDoc(doc("02", SPEC)) } })

describe("文档解析", () => {
  it("拆出 front-matter、正文、machine", () => {
    const d = parseDoc(doc("02", SPEC, { body: "# 需求\n\n```yaml\nnot: machine\n```\n" }))
    assert.deepEqual(d.errors, [])
    assert.equal(d.front.stage, "discovery")
    assert.equal(d.machine?.ac.length, 2)
    assert.match(d.body, /# 需求/) // 正文里的其他 yaml 块不算 machine
  })

  it("machine 块必须在最后；缺 front-matter、YAML 写坏都报出来", () => {
    assert.match(parseDoc(`${doc("02", SPEC)}\n后记\n`).errors.join(), /必须是文档的最后一部分/)
    assert.match(parseDoc("# 没有 front-matter\n```yaml\nmachine: {}\n```\n").errors.join(), /缺少 front-matter/)
    assert.match(parseDoc("---\nstage: x\n---\n```yaml\nmachine: [1, \n```\n").errors.join(), /machine 块不是合法 YAML/)
  })
})

describe("文档校验", () => {
  it("合格的 02 / 03 通过", () => {
    assert.deepEqual(lintDoc("02", doc("02", SPEC)).errors, [])
    assert.deepEqual(lintDoc("03", doc("03", DESIGN, { front: { stage: "tech-design", inputs: ["02"] } }), ctx()).errors, [])
  })

  it("front-matter 缺字段、阶段写错、枚举不合法一次列全", () => {
    const bad = { ...SPEC, ac: [{ id: "ac1", statement: "", priority: "must", verify: "eyeball" }] }
    const r = lintDoc("02", doc("02", bad, { front: { stage: "implement", config_hash: "" } }))
    assert.equal(r.ok, false)
    for (const msg of ["front-matter 缺少 config_hash", "stage 应为 discovery", "statement 不能为空", "verify 只能是", "id 必须形如 AC-1"])
      assert.ok(r.errors.some(e => e.includes(msg)), `缺少：${msg}\n${r.errors.join("\n")}`)
  })

  it("open_questions 必须清零；占位符不放过", () => {
    assert.match(lintDoc("02", doc("02", { ...SPEC, open_questions: ["颜色？"] })).errors.join(), /open_questions 必须清零/)
    assert.match(lintDoc("02", doc("02", SPEC, { body: "# 需求\n\n细节待补充\n" })).errors.join(), /占位符.*待补充/)
    assert.match(lintDoc("02", doc("02", SPEC, { body: "# 需求\n\nTODO: 写完\n" })).errors.join(), /占位符.*TODO/)
  })

  it("AC 覆盖 100%：03 少覆盖、多出 02 没有的 AC 都不行", () => {
    const partial = { ...DESIGN, ac_coverage: { "AC-1": DESIGN.ac_coverage["AC-1"], "AC-9": DESIGN.ac_coverage["AC-2"] } }
    const errors = lintDoc("03", doc("03", partial, { front: { stage: "tech-design" } }), ctx()).errors.join("\n")
    assert.match(errors, /没覆盖这些 AC：AC-2/)
    assert.match(errors, /02 不存在的 AC：AC-9/)
  })

  it("inputs 引用的文档必须存在", () => {
    assert.match(lintDoc("03", doc("03", DESIGN, { front: { stage: "tech-design", inputs: ["01"] } }), ctx()).errors.join(), /inputs 引用的 01 不存在/)
  })

  it("被 04 打回后，03 要用回应表逐条回应 fix_required 的问题", () => {
    const review = { verdict: "rejected", round: 1, items: [
      { id: "R-1", ac_ref: "AC-1", doc_ref: "03#方案", issue: "没说怎么校验", fix_required: true, severity: "major" },
      { id: "R-2", ac_ref: null, doc_ref: null, issue: "措辞", fix_required: false, severity: "minor" },
    ] }
    const others = { ...ctx().others, "04": parseDoc(doc("04", review, { front: { stage: "doc-review" } })) }
    const front = { stage: "tech-design", version: 2 }
    assert.match(lintDoc("03", doc("03", DESIGN, { front }), { others }).errors.join(), /没有回应 R-1/)
    const body = "# 技术设计\n\n| 问题 | 回应 |\n| --- | --- |\n| R-1 | 补了校验规则 |\n"
    assert.deepEqual(lintDoc("03", doc("03", DESIGN, { front, body }), { others }).errors, []) // R-2 不要求回应
  })

  it("写完代码后，03 的 impl / test 必须指向真实文件", () => {
    const root = tempDir()
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "login.ts"), "")
    const r = lintDoc("03", doc("03", DESIGN, { front: { stage: "tech-design" } }), { ...ctx(), projectRoot: root, implemented: true })
    assert.match(r.errors.join(), /AC-1\.test 指向的文件不存在：test\/login\.test\.ts/)
    assert.ok(!r.errors.some(e => e.includes(".impl")))
  })

  it("04：verdict 与 fix_required 一致，ac_ref 必须是 02 里的 AC", () => {
    const front = { stage: "doc-review" }
    const rejectedEmpty = { verdict: "rejected", round: 1, items: [] }
    assert.match(lintDoc("04", doc("04", rejectedEmpty, { front }), ctx()).errors.join(), /至少要有一条 fix_required/)
    const unknownAc = { verdict: "approved", round: 2, items: [{ id: "R-1", ac_ref: "AC-7", issue: "x", fix_required: false, severity: "minor" }] }
    assert.match(lintDoc("04", doc("04", unknownAc, { front }), ctx()).errors.join(), /AC-7 在 02 里不存在/)
  })

  it("06：pass 时 AC 全过且不回退；fail 时必须给出回到哪个阶段", () => {
    const front = { stage: "acceptance" }
    const passButFailed = { ac_status: { "AC-1": "pass", "AC-2": "fail" }, verdict: "pass", return_stage: null, evidence: [] }
    assert.match(lintDoc("06", doc("06", passButFailed, { front }), ctx()).errors.join(), /所有 AC 都必须是 pass/)
    const failNoStage = { ac_status: { "AC-1": "pass", "AC-2": "fail" }, verdict: "fail", return_stage: null, evidence: [] }
    assert.match(lintDoc("06", doc("06", failNoStage, { front }), ctx()).errors.join(), /必须给出 return_stage/)
    const missingAc = { ac_status: { "AC-1": "pass" }, verdict: "fail", return_stage: "implement", evidence: [] }
    assert.match(lintDoc("06", doc("06", missingAc, { front }), ctx()).errors.join(), /没覆盖这些 AC：AC-2/)
  })
})

describe("素材", () => {
  const png = (root: string, name: string, bytes: number[]): string => {
    const p = join(root, name)
    writeFileSync(p, Buffer.from(bytes))
    return p
  }
  const analysis = (assets: Json[]) => doc("01", { sources: [{ type: "image", ref: "upload", hash: "h" }], assets, open_questions: [] })

  it("按内容 hash 存进 assets/，同图只存一份；01 校验通过", () => {
    const root = tempDir()
    const docDir = join(root, "docs", "wwk", "20261024-login")
    const a = storeAsset(docDir, png(root, "shot.PNG", [1, 2, 3]))
    assert.match(a.path, /^assets\/[0-9a-f]{12}\.png$/)
    assert.deepEqual(storeAsset(docDir, png(root, "again.png", [1, 2, 3])), a)
    assert.deepEqual(lintDoc("01", analysis([{ ...a, kind: "screenshot", purpose: "登录页" }]), { docDir }).errors, [])
  })

  it("文件被改过、路径跳出目录、不是图片都拦下", () => {
    const root = tempDir()
    const docDir = join(root, "d")
    const a = storeAsset(docDir, png(root, "x.png", [9, 9]))
    writeFileSync(join(docDir, a.path), Buffer.from([0]))
    const tampered = lintDoc("01", analysis([{ ...a, kind: "k", purpose: "p" }]), { docDir }).errors.join("\n")
    assert.match(tampered, /文件名与内容的 hash 不符/)
    assert.match(tampered, /hash 与文件内容不符/)
    assert.match(lintDoc("01", analysis([{ path: "../secret.png", hash: "h", kind: "k", purpose: "p" }]), { docDir }).errors.join(), /必须形如 assets\//)
    assert.throws(() => storeAsset(docDir, png(root, "a.pdf", [1])), /只收图片/)
  })
})

describe("文档位置与版本历史", () => {
  it("01–03 在文档目录，04–06 在 .agent/stages/<stage>/", () => {
    assert.equal(docPath("02", "/p/docs/wwk/x", "/p/.agent"), join("/p/docs/wwk/x", "02-requirement-spec.md"))
    assert.equal(docPath("04", "/p/docs/wwk/x", "/p/.agent"), join("/p/.agent", "stages", "doc-review", "04-review-report.md"))
  })

  it("覆盖前存档：按 version 命名，没有 version 就顺延", () => {
    const root = tempDir()
    const state = join(root, ".agent")
    const file = join(root, "03.md")
    assert.equal(archiveDoc("03", file, state), null)
    writeFileSync(file, doc("03", DESIGN, { front: { stage: "tech-design", version: 3 } }))
    const v3 = archiveDoc("03", file, state)!
    assert.equal(v3, join(state, "stages", "tech-design", "history", "03-tech-design.v3.md"))
    writeFileSync(file, "没有 front-matter")
    assert.match(archiveDoc("03", file, state)!, /03-tech-design\.v1\.md$/)
    assert.match(archiveDoc("03", file, state)!, /03-tech-design\.v2\.md$/)
    assert.match(readFileSync(v3, "utf8"), /version: 3/)
  })
})

describe("提交路径白名单", () => {
  const opts = { repoDir: "docs/wwk" }
  const paths = (source: Parameters<typeof checkCommitPaths>[0], list: string[], extra = {}) =>
    checkCommitPaths(source, list, { ...opts, ...extra }).map(v => v.path)

  it("glob：** 可以跨层也可以是零层，{a,b} 是二选一", () => {
    assert.ok(matches("docs/wwk/**/{01,02}-*.md", "docs/wwk/20261024-x/01-design-analysis.md"))
    assert.ok(matches("docs/wwk/**/03-*.md", "docs/wwk/03-tech-design.md"))
    assert.ok(!matches("docs/wwk/**/{01,02}-*.md", "docs/wwk/x/03-tech-design.md"))
    assert.ok(matches(".github/**", ".github/workflows/ci.yml"))
    assert.ok(!matches(".env.*", "src/.env.ts"))
  })

  it("discovery 只能提交 01 / 02 和素材；tech-design 只能提交 03", () => {
    const d = "docs/wwk/20261024-login"
    assert.deepEqual(paths("discovery", [`${d}/01-design-analysis.md`, `${d}/02-requirement-spec.md`, `${d}/assets/0123456789ab.png`]), [])
    assert.deepEqual(paths("discovery", [`${d}/03-tech-design.md`, "src/a.ts"]), [`${d}/03-tech-design.md`, "src/a.ts"])
    assert.deepEqual(paths("tech-design", [`${d}/03-tech-design.md`, `${d}/02-requirement-spec.md`]), [`${d}/02-requirement-spec.md`])
  })

  it("implement / 门禁修复：代码随便改，文档、门禁规则、配置、.gitignore、CI 不能动", () => {
    const forbidden = ["docs/wwk/x/03-tech-design.md", "rules.yaml", "verify/verify.ts", "agent.config.json", ".gitignore", ".github/workflows/ci.yml", ".gitlab-ci.yml"]
    for (const source of ["implement", "gate-fix"] as const) {
      assert.deepEqual(paths(source, ["src/App.vue", "test/app.test.ts", "package.json", "docs/README.md"]), [])
      assert.deepEqual(paths(source, forbidden), forbidden)
    }
  })

  it(".agent/ 和 .env 谁都不能提交；门禁和验收本身不提交；验收打回按 return_stage", () => {
    assert.deepEqual(paths("implement", [".agent/lock", ".env", ".env.local"]), [".agent/lock", ".env", ".env.local"])
    assert.deepEqual(paths("gate", ["src/a.ts"]), ["src/a.ts"])
    assert.deepEqual(paths("acceptance-redo", ["src/a.ts"], { returnStage: "implement" }), [])
    assert.deepEqual(paths("acceptance-redo", ["src/a.ts"], { returnStage: "tech-design" }), ["src/a.ts"])
    assert.throws(() => paths("acceptance-redo", ["src/a.ts"]), /需要 return_stage/)
    assert.deepEqual(paths("implement", ["src\\win\\path.ts", "./src/b.ts"]), []) // Windows 分隔符、./ 前缀都统一
  })

  it("按暂存区把关：改名的两边都要过白名单", () => {
    const root = tempDir()
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
    git("init", "-q")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    writeFileSync(join(root, "rules.yaml"), "a: 1\n")
    git("add", ".")
    git("commit", "-qm", "init")
    git("mv", "rules.yaml", "rules-old.yaml") // 把门禁规则改名挪走，也算动了它
    writeFileSync(join(root, "app.ts"), "")
    git("add", ".")
    assert.throws(() => assertCommitAllowed(root, "implement", opts), (e: Error) => {
      assert.ok(e instanceof WhitelistError)
      assert.deepEqual(e.violations.map(v => v.path), ["rules.yaml"])
      assert.match(e.message, /implement 的提交越界，运行中止/)
      return true
    })
    git("reset", "-q")
    git("add", "app.ts")
    assertCommitAllowed(root, "implement", opts)
  })
})
