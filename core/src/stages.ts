// 文档阶段（第二阶段）：取材与需求（01 + 02）、技术设计（03）、文档复核（04，超轮次交 arbiter 仲裁）、产品验收（06）。
// - agent 只读：最后一条回复里给出正文 + 末尾 machine 块，流水线拼 front-matter、落盘、校验、提交；
// - 校验不过就把问题清单交还给 agent 重写，连续 limits.max_doc_lint_failures 次不过 = 运行失败；
// - 流程里不向人提问；agent 之间的一次补问（product 问 vision）不算。
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import YAML from "yaml"
import { type Agent, type AgentResult, buildAgent, END_TURN } from "./agents.ts"
import { type Config, prompt, render, writeText } from "./config.ts"
import { changedHunks } from "./diffs.ts"
import { archiveDoc, type DocId, DOCS, docPath, type LintContext, lintDoc, type ParsedDoc, parseDoc } from "./docs.ts"
import { slugify } from "./gitflow.ts"
import type { Deps } from "./deps.ts"
import type { State, Update } from "./state.ts"
import type { VisionInput, VisionResult } from "./vision.ts"
import type { StageName } from "./workflow.ts"

type Json = Record<string, any>

export interface RoleAgent {
  agent: Agent
  /** 预设 key，指标里显示 */
  name: string
}

/** 文档阶段用的只读 agent：claude 不批准编辑，ACP 只放 read / search / think；命令行 agent 限不住，靠提交白名单兜底。 */
export function buildRoleAgent(cfg: Config, role: string, override?: string | null): RoleAgent {
  const key = override || cfg.workflow.raw.roles?.[role]?.agent
  const preset = cfg.raw.coding_agents?.[key]
  if (!preset)
    throw new Error(`角色 ${role} 用的 agent「${key}」不在 coding_agents 里`)
  const section: Json = { timeout_sec: cfg.get("code").timeout_sec, ...preset }
  if (section.backend === "acp")
    section.allow_kinds = ["read", "search", "think"]
  if ((section.backend ?? "claude_cli") === "claude_cli")
    section.permission_mode = "default" // -p 模式下没批准的编辑一律拒绝
  return { agent: buildAgent(section, cfg, `${role}-task`), name: key }
}

/** 没有作业分支时（命令行）的文档目录：<repo_dir>/<日期>-<slug> */
export function defaultDocsDir(cfg: Config, requirement: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  return `${String(cfg.workflow.raw.documents.repo_dir).replace(/\/+$/, "")}/${date}-${slugify(requirement) || "run"}`
}

export const inputMode = (s: State): "text" | "image" | "mastergo" =>
  s.input_mode ?? (s.images?.length ? "image" : s.design_ref ? "mastergo" : "text")

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")
const docsDir = (deps: Deps, s: State): string => join(deps.cfg.projectRoot, s.docs_dir || defaultDocsDir(deps.cfg, s.requirement ?? ""))
const read = (p: string | undefined): string => (p && existsSync(p) ? readFileSync(p, "utf8") : "")
const parsed = (s: State, id: DocId): ParsedDoc | undefined => (s.artifacts?.[id] && existsSync(s.artifacts[id]) ? parseDoc(read(s.artifacts[id])) : undefined)
const title = (s: State): string => (s.requirement ?? "").split(/\r?\n/)[0].trim().slice(0, 60)
const limits = (cfg: Config): Json => cfg.workflow.raw.limits
const stageCfg = (cfg: Config, stage: StageName): Json => cfg.workflow.raw.stages[stage] ?? {}

// ---------------- 拼装与产出 ----------------

/** agent 回复 → 正文：去掉整段包着的代码块、front-matter、machine 块之后的闲话；bodyOnly 时连 machine 块也去掉。 */
export function extractBody(text: string, bodyOnly = false): string {
  let t = text.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t)
  if (fenced)
    t = fenced[1].trim()
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  if (bodyOnly)
    return t.replace(/```ya?ml\s*\n\s*machine\s*:[\s\S]*?```/g, "").trim()
  const blocks = [...t.matchAll(/```ya?ml[ \t]*\r?\n\s*machine\s*:[\s\S]*?\r?\n```/g)]
  const last = blocks.at(-1)
  return (last ? t.slice(0, last.index! + last[0].length) : t).trim()
}

export function assembleDoc(cfg: Config, id: DocId, role: string, version: number, inputs: string[], body: string, machine?: Json): string {
  const status = id === "04" && /verdict:\s*rejected/.test(body) ? "rejected" : "approved"
  const front = {
    stage: DOCS[id].stage, owner: role, status, version, inputs,
    config_hash: sha256(JSON.stringify(cfg.workflow.raw)).slice(0, 12),
    generated_at: new Date().toISOString(),
  }
  const tail = machine ? `\n\n\`\`\`yaml\n${YAML.stringify({ machine })}\`\`\`` : ""
  return `---\n${YAML.stringify(front)}---\n\n${body.trim()}${tail}\n`
}

/** 写文档：覆盖前把旧版本存进历史 */
function save(deps: Deps, s: State, id: DocId, text: string): string {
  const path = docPath(id, docsDir(deps, s), deps.cfg.stateDir)
  archiveDoc(id, path, deps.cfg.stateDir)
  writeText(path, text)
  return path
}

interface DocTask {
  id: DocId
  role: string
  round: number
  inputs: string[]
  /** feedback = 上一次校验不过的问题清单（第一次为空） */
  prompt: (feedback: string) => string
  /** 有值时 agent 只写正文，machine 块由代码给（01） */
  machine?: Json
  lint: LintContext
  /** 已经拿到的第一次回复（discovery 补问时复用） */
  first?: AgentResult
}

type DocOutcome = { ok: true, path: string, doc: ParsedDoc, text: string } | { ok: false, reason: string }

/** 跑 agent → 拼文档 → 校验；不过就带着问题清单重写，连续 max_doc_lint_failures 次不过算失败。 */
async function produce(deps: Deps, s: State, task: DocTask, ra: RoleAgent): Promise<DocOutcome> {
  const stage = DOCS[task.id].stage
  const max = Number(limits(deps.cfg).max_doc_lint_failures ?? 3)
  let feedback = ""
  let errors: string[] = []
  for (let i = 1; i <= max; i++) {
    let r = i === 1 ? task.first : undefined
    if (!r) {
      deps.log(`[${stage}] ${ra.name} 写 ${DOCS[task.id].file}${i > 1 ? `（第 ${i} 次，按校验意见重写）` : ""}…`)
      const t = Date.now()
      r = await ra.agent.run(task.prompt(feedback), deps.cfg.projectRoot)
      deps.metrics?.agentCall(stage, task.role, ra.name, task.round, Date.now() - t, r)
    }
    if (r.stopReason !== END_TURN)
      return { ok: false, reason: `DOC_AGENT_ERROR: ${ra.name} 写 ${task.id} 时 stop_reason=${r.stopReason}：${r.text.slice(-300)}` }
    const text = assembleDoc(deps.cfg, task.id, task.role, task.round, task.inputs, extractBody(r.text, Boolean(task.machine)), task.machine)
    const lint = lintDoc(task.id, text, task.lint)
    if (lint.ok) {
      const path = save(deps, s, task.id, text)
      deps.log(`[${stage}] ${DOCS[task.id].file} 通过校验，已写入 ${path}`)
      return { ok: true, path, doc: lint.doc, text }
    }
    errors = lint.errors
    deps.metrics?.reject(stage, task.round, "lint", ra.name, errors)
    deps.log(`[${stage}] ${task.id} 没通过校验（${errors.length} 个问题）：${errors.slice(0, 3).join("；")}`)
    feedback = `## 上一次的输出没有通过校验\n\n${errors.map(e => `- ${e}`).join("\n")}\n\n请逐条修正后，完整重写（正文 + 末尾 machine 块）。`
  }
  return { ok: false, reason: `DOC_LINT_FAILED: ${task.id} 连续 ${max} 次没有通过校验：${errors.slice(0, 5).join("；")}` }
}

const rules = (): string => prompt("doc-rules.md")
const quoted = (text: string): string => text.split(/\r?\n/).map(l => `> ${l}`).join("\n")
const fail = (reason: string, stage: StageName): Update => ({ break_reason: reason, stage_status: { [stage]: "failed" } })

/** 验收打回的重做做完了：清掉回退标记和意见，免得下游阶段以为自己也在重做 */
export const redoDone = (s: State, stage: StageName): Update => (s.return_stage === stage ? { return_stage: null, feedback: null } : {})

/** 提交本阶段的入库文档（有作业分支时）；越界 / 出错转成 break_reason */
function commitDocs(deps: Deps, source: "discovery" | "tech-design", round: number, summary: string, role: string): Update {
  if (!deps.commit)
    return {}
  try {
    const hash = deps.commit(source, round, summary)
    deps.log(hash ? `[提交] ${source} 第 ${round} 轮：${hash.slice(0, 7)}` : "[提交] 没有改动，跳过")
    return {}
  }
  catch (e) {
    const err = e as Error & { violations?: { path: string }[] }
    if (err.violations)
      deps.metrics?.reject(source, round, "whitelist", role, err.violations.map(v => v.path))
    return { break_reason: `${err.violations ? "WHITELIST_VIOLATION" : "COMMIT_ERROR"}: ${err.message}` }
  }
}

// ---------------- 取材与需求 ----------------

/** 纯文字需求的 01：没有可分析的素材，直接由代码生成，不花 token */
function textAnalysis(requirement: string): { body: string, machine: Json } {
  return {
    body: `# 设计分析\n\n## 概览\n\n本次只有文字需求，没有设计稿或图片。\n\n## 需求原文\n\n${quoted(requirement.trim())}\n\n## 不确定的地方\n\n界面布局与视觉样式没有素材可依，由需求规格和技术设计按项目现有风格确定。`,
    machine: { sources: [{ type: "text", ref: "需求原文", hash: sha256(requirement) }], assets: [], open_questions: [] },
  }
}

/** 01 入库，来源里不写本机绝对路径：项目里的文件记相对路径，项目外的只记文件名 */
function designRef(root: string, ref: string): string {
  if (!/[\\/]/.test(ref))
    return ref // mastergo / selection
  const rel = relative(root, ref).replaceAll("\\", "/")
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(ref)
}

const ASK_VISION = /^\s*【问视觉】\s*([\s\S]+)$/

export async function discoveryStage(deps: Deps, s: State, opts: { vision: (input: VisionInput) => Promise<VisionResult>, roleAgent: (role: string) => RoleAgent }): Promise<Update> {
  const { cfg } = deps
  const mode = inputMode(s)
  const intake = cfg.workflow.raw.input_modes?.[mode]?.intake
  if (!intake)
    return fail(`DOC_AGENT_ERROR: 输入方式 ${mode} 没有在 input_modes 里配置`, "discovery")
  const round = (s.acceptance_round ?? 0) + 1
  const dir = docsDir(deps, s)
  const redo = s.return_stage === "discovery" && s.feedback ? `\n\n## 上一轮产品验收的意见（这次要改正）\n\n${s.feedback}` : ""
  const requirement = (s.requirement ?? "") + redo
  const product = opts.roleAgent("product")
  deps.log(`[取材与需求] 输入方式：${{ text: "纯文字", image: "图片 + 文字", mastergo: "MasterGo 设计稿" }[mode]}`)

  // ---- 01 ----
  let p01: string
  let text01: string
  const runVision = async (question?: string): Promise<DocOutcome> => {
    const max = Number(limits(cfg).max_doc_lint_failures ?? 3)
    let q = question
    let errors: string[] = []
    for (let i = 1; i <= max; i++) {
      const t = Date.now()
      let r: VisionResult
      try {
        r = await opts.vision({ images: s.images ?? [], requirement: s.requirement ?? "", docDir: dir, question: q })
      }
      catch (e) {
        return { ok: false, reason: `VISION_ERROR: ${(e as Error).message}` }
      }
      deps.metrics?.agentCall("discovery", "vision", cfg.workflow.raw.roles.vision.agent, round, Date.now() - t, { stopReason: END_TURN })
      if (r.lint.ok) {
        const path = save(deps, s, "01", r.text)
        deps.log(`[取材与需求] vision（${r.backend}${r.cached ? "，缓存" : ""}）写好 01`)
        return { ok: true, path, doc: r.lint.doc, text: r.text }
      }
      errors = r.lint.errors
      deps.metrics?.reject("discovery", round, "lint", cfg.workflow.raw.roles.vision.agent, errors)
      q = [question, `上一次的结果没有通过校验，请修正：\n${errors.map(e => `- ${e}`).join("\n")}`].filter(Boolean).join("\n\n")
    }
    return { ok: false, reason: `DOC_LINT_FAILED: 01 连续 ${max} 次没有通过校验：${errors.slice(0, 5).join("；")}` }
  }

  if (mode === "text") {
    const a = textAnalysis(s.requirement ?? "")
    text01 = assembleDoc(cfg, "01", "product", round, [], a.body, a.machine)
    p01 = save(deps, s, "01", text01)
  }
  else if (mode === "image") {
    const r = await runVision()
    if (!r.ok)
      return fail(r.reason, "discovery")
    ;[p01, text01] = [r.path, r.text]
  }
  else {
    let design: Json | null
    try {
      design = await deps.design(s.design_ref)
    }
    catch (e) {
      return fail(`DESIGN_ERROR: ${(e as Error).message}`, "discovery")
    }
    const json = JSON.stringify(design ?? {}, null, 2)
    const r = await produce(deps, s, {
      id: "01", role: "product", round, inputs: [],
      prompt: fb => render(prompt("mastergo-analysis-prompt.md"), { requirement, design: json }) + (fb ? `\n\n${fb}` : ""),
      machine: { sources: [{ type: "mastergo", ref: designRef(cfg.projectRoot, String(s.design_ref)), hash: sha256(json) }], assets: [], open_questions: [] },
      lint: { docDir: dir },
    }, product)
    if (!r.ok)
      return fail(r.reason, "discovery")
    ;[p01, text01] = [r.path, r.text]
  }

  // ---- 02 ----
  const p02prompt = (fb: string, allowAsk: boolean) => render(prompt("requirement-prompt.md"), {
    requirement,
    analysis: parseDoc(text01).body.trim(),
    ask_vision: allowAsk
      ? "如果 01 缺了写需求必需、而且只能从图上看出来的信息，你可以先向视觉分析员提一个问题：整条回复只写一行 `【问视觉】你的问题`。只有这一次机会，不需要就直接写需求规格。"
      : "",
    feedback: fb,
    rules: rules(),
  })
  let first: AgentResult | undefined
  if (mode === "image") { // product 可以向 vision 补问一次
    const t = Date.now()
    first = await product.agent.run(p02prompt("", true), cfg.projectRoot)
    deps.metrics?.agentCall("discovery", "product", product.name, round, Date.now() - t, first)
    const ask = first.stopReason === END_TURN ? ASK_VISION.exec(first.text.trim()) : null
    if (ask) {
      deps.log(`[取材与需求] product 补问 vision：${ask[1].trim().slice(0, 200)}`)
      const r = await runVision(ask[1].trim())
      if (!r.ok)
        return fail(r.reason, "discovery")
      ;[p01, text01] = [r.path, r.text]
      first = undefined
    }
  }
  const others = { "01": parseDoc(text01) }
  const r02 = await produce(deps, s, {
    id: "02", role: "product", round, inputs: ["01"], first,
    prompt: fb => p02prompt(fb, false), lint: { others, docDir: dir },
  }, product)
  if (!r02.ok)
    return fail(r02.reason, "discovery")
  const committed = commitDocs(deps, "discovery", round, title(s), product.name)
  if (committed.break_reason)
    return { ...committed, stage_status: { discovery: "failed" } }
  return { artifacts: { "01": p01, "02": r02.path }, stage_status: { discovery: "done" }, ...redoDone(s, "discovery") }
}

// ---------------- 技术设计 ----------------

export async function techDesignStage(deps: Deps, s: State, opts: { roleAgent: (role: string) => RoleAgent }): Promise<Update> {
  const tech = opts.roleAgent("tech")
  const d02 = read(s.artifacts?.["02"])
  if (!d02)
    return fail("DOC_AGENT_ERROR: 没有需求规格（02），技术设计无从下手", "tech-design")
  const rejected = s.review_verdict === "rejected"
  const review = rejected ? read(s.artifacts?.["04"]) : ""
  const round = (s.doc_round ?? 0) + (s.acceptance_round ?? 0) + 1
  const redo = s.return_stage === "tech-design" && s.feedback ? `## 上一轮产品验收的意见（这次要改正）\n\n${s.feedback}` : ""
  const others: Partial<Record<DocId, ParsedDoc>> = { "01": parsed(s, "01"), "02": parseDoc(d02) }
  if (rejected && review)
    others["04"] = parseDoc(review)
  const r = await produce(deps, s, {
    id: "03", role: "tech", round, inputs: rejected ? ["01", "02", "04"] : ["01", "02"],
    prompt: fb => render(prompt("tech-design-prompt.md"), {
      requirement: s.requirement ?? "",
      spec: parseDoc(d02).body.trim() + `\n\n\`\`\`yaml\n${YAML.stringify({ machine: parseDoc(d02).machine })}\`\`\``,
      review: rejected
        ? `## 上一版被文档复核打回（04），这次要改\n\n${parseDoc(review).body.trim()}\n\n\`\`\`yaml\n${YAML.stringify({ machine: parseDoc(review).machine })}\`\`\`\n\n正文里必须有一张「回应表」（Markdown 表格），逐条回应上面每个 fix_required: true 的问题：| 问题编号 | 怎么改的 |。`
        : "",
      feedback: [redo, fb].filter(Boolean).join("\n\n"),
      rules: rules(),
    }),
    lint: { others, docDir: docsDir(deps, s) },
  }, tech)
  if (!r.ok)
    return fail(r.reason, "tech-design")
  const committed = commitDocs(deps, "tech-design", round, title(s), tech.name)
  if (committed.break_reason)
    return { ...committed, stage_status: { "tech-design": "failed" } }
  return { artifacts: { "03": r.path }, stage_status: { "tech-design": "done" }, ...redoDone(s, "tech-design") }
}

// ---------------- 文档复核 + 仲裁 ----------------

export async function docReviewStage(deps: Deps, s: State, opts: { roleAgent: (role: string) => RoleAgent }): Promise<Update> {
  const { cfg } = deps
  const product = opts.roleAgent("product")
  const sc = stageCfg(cfg, "doc-review")
  const max = Number(sc.max_rounds ?? 2)
  const round = (s.doc_round ?? 0) + 1
  const d02 = read(s.artifacts?.["02"])
  const d03 = read(s.artifacts?.["03"])
  if (!d02 || !d03)
    return fail("DOC_AGENT_ERROR: 文档复核需要 02 和 03", "doc-review")
  const r = await produce(deps, s, {
    id: "04", role: "product", round, inputs: ["02", "03"],
    prompt: fb => render(prompt("doc-review-prompt.md"), { round: String(round), max_rounds: String(max), spec: d02, design: d03 }) + `\n\n${rules()}${fb ? `\n\n${fb}` : ""}`,
    lint: { others: { "02": parseDoc(d02), "03": parseDoc(d03) } },
  }, product)
  if (!r.ok)
    return fail(r.reason, "doc-review")
  const m = r.doc.machine!
  if (m.verdict === "approved") {
    deps.log(`[文档复核] 第 ${round} 轮通过`)
    return { artifacts: { "04": r.path }, doc_round: round, review_verdict: "approved", stage_status: { "doc-review": "done" } }
  }
  const issues = (m.items as Json[]).filter(x => x.fix_required).map(x => `${x.id}：${x.issue}`)
  deps.metrics?.reject("tech-design", round, "doc-review", opts.roleAgent("tech").name, issues)
  if (round < max) {
    deps.log(`[文档复核] 第 ${round} 轮打回（${issues.length} 个必须改的问题），技术设计重写`)
    return { artifacts: { "04": r.path }, doc_round: round, review_verdict: "rejected" }
  }
  return arbitrate(deps, s, { ...opts, round, d02, d03, sc })
}

async function arbitrate(deps: Deps, s: State, o: { roleAgent: (role: string) => RoleAgent, round: number, d02: string, d03: string, sc: Json }): Promise<Update> {
  const role = o.sc.on_exceed ?? "arbiter"
  deps.log(`[文档复核] ${o.round} 轮仍未通过，交 ${role} 仲裁`)
  const arbiter = o.roleAgent(role)
  const history = join(deps.cfg.stateDir, "stages", "doc-review", "history")
  const reviews = [read(s.artifacts?.["04"])]
  for (let v = 1; v < o.round; v++)
    reviews.unshift(read(join(history, `04-review-report.v${v}.md`)))
  const t = Date.now()
  const r = await arbiter.agent.run(render(prompt("arbiter-prompt.md"), {
    rounds: String(o.round), spec: o.d02, design: o.d03, reviews: reviews.filter(Boolean).join("\n\n---\n\n"),
  }), deps.cfg.projectRoot)
  deps.metrics?.agentCall("doc-review", role, arbiter.name, o.round, Date.now() - t, r)
  const machine = r.stopReason === END_TURN ? parseDoc(`---\nx: 1\n---\n${extractBody(r.text)}`).machine : null
  const verdict = machine?.verdict
  const file = join(deps.cfg.stateDir, "arbitration", `${basename(s.docs_dir || "run")}-ruling.md`)
  writeText(file, `# 仲裁结论\n\n- 结论：${verdict ?? "无效"}\n- 仲裁者：${arbiter.name}\n- 时间：${new Date().toISOString()}\n\n${r.text}\n`)
  if (verdict === "approve") {
    const notes = Array.isArray(machine!.notes) ? machine!.notes.map(String) : []
    deps.log(`[文档复核] 仲裁通过，继续实现${notes.length ? `（遗留 ${notes.length} 个问题交给开发）` : ""}`)
    return {
      doc_round: o.round, review_verdict: "approved", stage_status: { "doc-review": "done" },
      feedback: notes.length ? `## 仲裁留给开发的问题\n\n${notes.map(n => `- ${n}`).join("\n")}` : s.feedback,
    }
  }
  deps.metrics?.reject("tech-design", o.round, "arbiter", o.roleAgent("tech").name, Array.isArray(machine?.reasons) ? machine!.reasons.map(String) : [r.text.slice(-200)])
  return fail(`DOC_REVIEW_REJECTED: ${verdict === "reject" ? "仲裁判定技术设计不可用" : `仲裁没给出有效结论（stop_reason=${r.stopReason}）`}，见 ${file}`, "doc-review")
}

// ---------------- 产品验收 ----------------

export async function acceptanceStage(deps: Deps, s: State, opts: { roleAgent: (role: string) => RoleAgent, enabled: StageName[] }): Promise<Update> {
  const { cfg } = deps
  const product = opts.roleAgent("product")
  const max = Number(stageCfg(cfg, "acceptance").max_rounds ?? 2)
  const round = (s.acceptance_round ?? 0) + 1
  const d02 = read(s.artifacts?.["02"])
  if (!d02)
    return fail("DOC_AGENT_ERROR: 产品验收需要需求规格（02）", "acceptance")
  const d03 = read(s.artifacts?.["03"])
  const d05 = read(s.artifacts?.["05"])
  const dcfg = cfg.get("diff")
  const hunks = changedHunks(cfg.projectRoot, s.baseline, [], Number(dcfg.max_chars ?? 12000), Number(dcfg.context_lines ?? 3))
  const files = s.changed_files?.length ? s.changed_files : [...new Set(hunks.map(h => h.file))]
  const r = await produce(deps, s, {
    id: "06", role: "product", round, inputs: d03 ? ["02", "03"] : ["02"],
    prompt: fb => render(prompt("acceptance-prompt.md"), {
      round: String(round), max_rounds: String(max), spec: d02, design: d03 || "（未做技术设计）",
      files: files.length ? files.map(f => `- ${f}`).join("\n") : "（没有检测到改动）",
      diff: hunks.map(h => `### ${h.file}\n\`\`\`diff\n${h.patch}\n\`\`\``).join("\n\n") || "（无）",
      self_test: d05 ? `开发的自测（05）：\n\n${d05}` : "",
      rules: rules(),
    }) + (fb ? `\n\n${fb}` : ""),
    lint: { others: { "02": parseDoc(d02), ...(d03 ? { "03": parseDoc(d03) } : {}) } },
  }, product)
  if (!r.ok)
    return fail(r.reason, "acceptance")
  const m = r.doc.machine!
  if (m.verdict === "pass") {
    deps.log(`[产品验收] 第 ${round} 轮通过`)
    return { artifacts: { "06": r.path }, acceptance_round: round, acceptance_verdict: "pass", stage_status: { acceptance: "done" } }
  }
  const failed = Object.entries(m.ac_status as Json).filter(([, v]) => v !== "pass").map(([k]) => k)
  let back: string = m.return_stage
  if (!opts.enabled.includes(back as StageName))
    back = "implement" // 回不去的阶段（被关掉了）按实现问题处理
  const producer = back === "implement" ? deps.agentNames?.coder ?? null : opts.roleAgent(back === "tech-design" ? "tech" : "product").name
  deps.metrics?.reject(back, round, "acceptance", producer, failed.map(ac => `${ac} 未达成`))
  if (round >= max)
    return { artifacts: { "06": r.path }, acceptance_round: round, ...fail(`ACCEPTANCE_FAILED: 验收 ${round} 轮仍未通过（${failed.join("、")}）`, "acceptance") }
  deps.log(`[产品验收] 第 ${round} 轮没通过（${failed.join("、")}），回到 ${back} 重做`)
  const reasons = (m.evidence as unknown[]).map(String).slice(0, 10)
  return {
    artifacts: { "06": r.path },
    acceptance_round: round,
    acceptance_verdict: "fail",
    return_stage: back,
    review_verdict: null,
    doc_round: 0,
    feedback: `未达成的验收标准：${failed.join("、")}\n\n${r.doc.body.trim().slice(0, 3000)}${reasons.length ? `\n\n依据：\n${reasons.map(x => `- ${x}`).join("\n")}` : ""}`,
  }
}

// ---------------- 实现阶段的文档 ----------------

/** 有 02 / 03 时，编码直接用它们当 Spec（不再单独生成） */
export function specFromDocs(s: State): string | null {
  const d02 = read(s.artifacts?.["02"])
  if (!d02)
    return null
  const d03 = read(s.artifacts?.["03"])
  return [`# 需求规格（02）\n\n${d02}`, d03 ? `# 技术设计（03）\n\n${d03}` : ""].filter(Boolean).join("\n\n")
}

/** 编码 prompt 里要求的 05 自测块 */
export function selfTestAsk(s: State): string {
  const ac = parsed(s, "02")?.machine?.ac
  if (!Array.isArray(ac))
    return ""
  return `\n## 自测（05）\n\n完成后在回复的最后附上自测结果（只判断你能确认的，不确定就写 fail），格式：\n\n\`\`\`yaml\nmachine:\n  ac_status:\n${ac.map((x: Json) => `    ${x.id}: pass`).join("\n")}\n  uncovered: []            # 没有覆盖到的 AC 编号\n  deviates_from_design: false   # 实现是否偏离了技术设计（03）\n\`\`\`\n`
}

/** 从编码 agent 的回复里取 05；拿不到或不合格只记一笔，不拦（验收会再看代码） */
export function saveSelfTest(deps: Deps, s: State, text: string, agentName: string, round: number): string | null {
  const body = extractBody(text)
  if (!/```ya?ml[\s\S]*machine\s*:/.test(body)) {
    deps.log("[写代码] 回复里没有自测（05）块，跳过")
    return null
  }
  const d03 = parsed(s, "03")
  const doc = assembleDoc(deps.cfg, "05", "dev", round, d03 ? ["02", "03"] : ["02"], `# 自测\n\n${body}`)
  const lint = lintDoc("05", doc, { others: { "02": parsed(s, "02"), "03": d03 } })
  if (!lint.ok) {
    deps.metrics?.reject("implement", round, "lint", agentName, lint.errors)
    deps.log(`[写代码] 自测（05）没通过校验，未采用：${lint.errors.slice(0, 3).join("；")}`)
    return null
  }
  return save(deps, s, "05", doc)
}
