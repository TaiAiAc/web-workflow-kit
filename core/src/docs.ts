// 文档契约（第二阶段）：01–06 号文档 = front-matter + 正文 + 末尾 ```yaml machine: {...}```，machine 块是唯一权威。
// - 01/02/03 入库（<documents.repo_dir>/<日期>-<slug>/），04/05/06 留在 .agent/stages/<stage>/；
// - 校验零 token：front-matter 完整、machine 合 schema、AC 覆盖 100%、引用存在、open_questions 清零、无占位符；
//   不过就打回重写，不占复核轮次（连续失败的上限由流水线按 limits.max_doc_lint_failures 管）；
// - 01 引用的素材放在文档目录的 assets/ 下，文件名 = 内容 sha256 前 12 位 + 扩展名。
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import YAML from "yaml"
import { writeText } from "./config.ts"
import type { StageName } from "./workflow.ts"

type Json = Record<string, any>

export const DOC_IDS = ["01", "02", "03", "04", "05", "06"] as const
export type DocId = typeof DOC_IDS[number]

export interface DocSpec {
  file: string
  stage: StageName
  /** 入库（随作业分支提交）还是只留在 .agent/ */
  repo: boolean
}

export const DOCS: Record<DocId, DocSpec> = {
  "01": { file: "01-design-analysis.md", stage: "discovery", repo: true },
  "02": { file: "02-requirement-spec.md", stage: "discovery", repo: true },
  "03": { file: "03-tech-design.md", stage: "tech-design", repo: true },
  "04": { file: "04-review-report.md", stage: "doc-review", repo: false },
  "05": { file: "05-self-test.md", stage: "implement", repo: false },
  "06": { file: "06-acceptance-report.md", stage: "acceptance", repo: false },
}

/** 文档放哪：入库的在本次运行的文档目录，其余在 .agent/stages/<stage>/。 */
export function docPath(id: DocId, docDir: string, stateDir: string): string {
  const spec = DOCS[id]
  return spec.repo ? join(docDir, spec.file) : join(stateDir, "stages", spec.stage, spec.file)
}

// ---------------- 解析 ----------------

export interface ParsedDoc {
  front: Json
  body: string
  machine: Json | null
  /** 结构问题（没有 front-matter、machine 块不在末尾、YAML 写坏了……） */
  errors: string[]
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FENCE = /```ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```/g

export function parseDoc(text: string): ParsedDoc {
  const errors: string[] = []
  let front: Json = {}
  let rest = text
  const m = FRONT.exec(text)
  if (!m) {
    errors.push("缺少 front-matter（文件开头的 --- … --- 块）")
  }
  else {
    rest = text.slice(m[0].length)
    try {
      const data = YAML.parse(m[1])
      if (isObject(data))
        front = data
      else
        errors.push("front-matter 必须是键值对")
    }
    catch (e) {
      errors.push(`front-matter 不是合法 YAML：${(e as Error).message.split("\n")[0]}`)
    }
  }

  // machine 块：最后一个 ```yaml 块，且后面只能有空白
  const fences = [...rest.matchAll(FENCE)]
  const last = fences.at(-1)
  let machine: Json | null = null
  let body = rest
  if (!last || !/^\s*machine\s*:/m.test(last[1])) {
    errors.push("缺少末尾的 ```yaml machine: … ``` 块")
  }
  else if (rest.slice(last.index! + last[0].length).trim()) {
    errors.push("machine 块必须是文档的最后一部分，后面不能再有内容")
  }
  else {
    body = rest.slice(0, last.index)
    try {
      const data = YAML.parse(last[1])
      if (isObject(data) && isObject(data.machine))
        machine = data.machine
      else
        errors.push("machine 必须是对象")
    }
    catch (e) {
      errors.push(`machine 块不是合法 YAML：${(e as Error).message.split("\n")[0]}`)
    }
  }
  return { front, body, machine, errors }
}

// ---------------- schema ----------------

const FRONT_KEYS = ["stage", "owner", "status", "version", "inputs", "config_hash", "generated_at"] as const
const STATUSES = ["draft", "approved", "rejected"]

type Check = (ok: boolean, msg: string) => void

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""
const oneOf = (v: unknown, values: readonly unknown[]): boolean => values.includes(v)
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

function list(m: Json, key: string, need: Check, item?: (x: any, path: string) => void): any[] {
  const v = m[key]
  need(Array.isArray(v), `machine.${key} 必须是数组`)
  if (!Array.isArray(v))
    return []
  v.forEach((x, i) => {
    if (!item)
      return
    if (!isObject(x)) {
      need(false, `machine.${key}[${i}] 必须是对象`)
      return
    }
    item(x, `machine.${key}[${i}]`)
  })
  return v
}

function ids(items: any[], key: string, prefix: string, need: Check): string[] {
  const out: string[] = []
  for (const [i, x] of items.entries()) {
    const id = x?.id
    need(typeof id === "string" && new RegExp(`^${prefix}-\\d+$`).test(id), `machine.${key}[${i}].id 必须形如 ${prefix}-1`)
    need(!out.includes(id), `machine.${key} 里的 id 重复：${id}`)
    out.push(id)
  }
  return out
}

const AC_STATUS = ["pass", "fail"]

const SCHEMAS: Record<DocId, (m: Json, need: Check) => void> = {
  "01": (m, need) => {
    list(m, "sources", need, (x, p) => {
      need(oneOf(x.type, ["mastergo", "image", "text"]), `${p}.type 只能是 mastergo / image / text`)
      need(str(x.ref), `${p}.ref 不能为空`)
      need(str(x.hash), `${p}.hash 不能为空`)
    })
    list(m, "assets", need, (x, p) => {
      for (const k of ["path", "kind", "hash", "purpose"])
        need(str(x[k]), `${p}.${k} 不能为空`)
    })
    list(m, "open_questions", need)
  },
  "02": (m, need) => {
    const ac = list(m, "ac", need, (x, p) => {
      need(str(x.statement), `${p}.statement 不能为空`)
      need(oneOf(x.priority, ["must", "should"]), `${p}.priority 只能是 must / should`)
      need(oneOf(x.verify, ["auto", "screenshot", "manual-review"]), `${p}.verify 只能是 auto / screenshot / manual-review`)
    })
    need(ac.length > 0, "machine.ac 至少要有一条验收标准")
    ids(ac, "ac", "AC", need)
    const assumptions = list(m, "assumptions", need, (x, p) => {
      need(str(x.statement), `${p}.statement 不能为空`)
      need(oneOf(x.risk, ["low", "medium", "high"]), `${p}.risk 只能是 low / medium / high`)
    })
    ids(assumptions, "assumptions", "A", need)
    list(m, "non_goals", need)
    list(m, "open_questions", need)
  },
  "03": (m, need) => {
    need(isObject(m.ac_coverage), "machine.ac_coverage 必须是对象（AC 编号 → {impl, test}）")
    for (const [ac, v] of Object.entries(isObject(m.ac_coverage) ? m.ac_coverage : {})) {
      need(isObject(v) && str(v.impl) && str(v.test), `machine.ac_coverage.${ac} 需要 impl 和 test（形如 文件#位置）`)
    }
    const decisions = list(m, "decisions", need, (x, p) => {
      need(str(x.decision), `${p}.decision 不能为空`)
      need(Array.isArray(x.alternatives), `${p}.alternatives 必须是数组`)
      need(str(x.reason), `${p}.reason 不能为空`)
    })
    ids(decisions, "decisions", "D", need)
    list(m, "touches", need)
    need(oneOf(m.risk, ["low", "medium", "high"]), "machine.risk 只能是 low / medium / high")
  },
  "04": (m, need) => {
    need(oneOf(m.verdict, ["approved", "rejected"]), "machine.verdict 只能是 approved / rejected")
    need(Number.isInteger(m.round) && m.round >= 1, "machine.round 必须是 ≥ 1 的整数")
    const items = list(m, "items", need, (x, p) => {
      need(str(x.issue), `${p}.issue 不能为空`)
      need(typeof x.fix_required === "boolean", `${p}.fix_required 必须是 true / false`)
      need(oneOf(x.severity, ["blocker", "major", "minor"]), `${p}.severity 只能是 blocker / major / minor`)
      need(x.ac_ref == null || str(x.ac_ref), `${p}.ac_ref 必须是 AC 编号或留空`)
      need(x.doc_ref == null || str(x.doc_ref), `${p}.doc_ref 必须是文档位置或留空`)
    })
    ids(items, "items", "R", need)
    const required = items.filter(x => x?.fix_required)
    need(m.verdict !== "rejected" || required.length > 0, "verdict=rejected 时至少要有一条 fix_required 的问题")
    need(m.verdict !== "approved" || required.length === 0, "verdict=approved 时不能再有 fix_required 的问题")
  },
  "05": (m, need) => {
    need(isObject(m.ac_status), "machine.ac_status 必须是对象（AC 编号 → pass / fail）")
    for (const [ac, v] of Object.entries(isObject(m.ac_status) ? m.ac_status : {}))
      need(oneOf(v, AC_STATUS), `machine.ac_status.${ac} 只能是 pass / fail`)
    list(m, "uncovered", need)
    need(typeof m.deviates_from_design === "boolean", "machine.deviates_from_design 必须是 true / false")
  },
  "06": (m, need) => {
    need(isObject(m.ac_status), "machine.ac_status 必须是对象（AC 编号 → pass / fail）")
    const status = isObject(m.ac_status) ? m.ac_status : {}
    for (const [ac, v] of Object.entries(status))
      need(oneOf(v, AC_STATUS), `machine.ac_status.${ac} 只能是 pass / fail`)
    need(oneOf(m.verdict, ["pass", "fail"]), "machine.verdict 只能是 pass / fail")
    need(m.return_stage === null || oneOf(m.return_stage, ["discovery", "tech-design", "implement"]),
      "machine.return_stage 只能是 null / discovery / tech-design / implement")
    need(m.verdict !== "fail" || m.return_stage !== null, "verdict=fail 时必须给出 return_stage")
    need(m.verdict !== "pass" || m.return_stage === null, "verdict=pass 时 return_stage 必须是 null")
    need(m.verdict !== "pass" || Object.values(status).every(v => v === "pass"), "verdict=pass 时所有 AC 都必须是 pass")
    list(m, "evidence", need)
  },
}

// ---------------- 校验 ----------------

export interface LintContext {
  /** 同一次运行里已通过的其他文档（AC 覆盖、引用、回应表都靠它） */
  others?: Partial<Record<DocId, ParsedDoc>>
  /** 文档目录：检查 01 的素材 */
  docDir?: string
  /** 项目根目录：implemented=true 时检查 03 里 impl / test 指向的文件 */
  projectRoot?: string
  /** 代码已经写完（门禁、验收时）：03 的 ac_coverage 文件引用必须真实存在 */
  implemented?: boolean
}

export interface LintResult {
  ok: boolean
  errors: string[]
  doc: ParsedDoc
}

// 只认明显的占位写法；「待」「TODO」出现在正常行文里的概率很低
const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|XXX)\b|待补充|待定|待完善|待确认|\{\{[^}]*\}\}|<placeholder>|lorem ipsum/i

/** 校验一份文档；errors 一次列全，打回时整段交给 agent。 */
export function lintDoc(id: DocId, text: string, ctx: LintContext = {}): LintResult {
  const doc = parseDoc(text)
  const errors = [...doc.errors]
  const need: Check = (ok, msg) => {
    if (!ok)
      errors.push(msg)
  }

  if (!doc.errors.some(e => e.startsWith("缺少 front-matter") || e.startsWith("front-matter"))) {
    for (const k of FRONT_KEYS)
      need(doc.front[k] !== undefined && doc.front[k] !== null && doc.front[k] !== "", `front-matter 缺少 ${k}`)
    need(doc.front.stage === undefined || doc.front.stage === DOCS[id].stage, `front-matter.stage 应为 ${DOCS[id].stage}（当前 ${doc.front.stage}）`)
    need(doc.front.status === undefined || STATUSES.includes(doc.front.status), "front-matter.status 只能是 draft / approved / rejected")
    need(doc.front.version === undefined || (Number.isInteger(doc.front.version) && doc.front.version >= 1), "front-matter.version 必须是 ≥ 1 的整数")
    need(doc.front.inputs === undefined || Array.isArray(doc.front.inputs), "front-matter.inputs 必须是数组")
    need(doc.front.generated_at === undefined || !Number.isNaN(Date.parse(String(doc.front.generated_at))), "front-matter.generated_at 必须是时间（ISO 8601）")
  }

  const m = doc.machine
  if (m) {
    SCHEMAS[id](m, need)
    crossCheck(id, m, doc, ctx, need)
  }

  // 引用块（> 开头）是原样引用的需求原文等材料，里面出现「待定」之类不算没填
  const hit = PLACEHOLDER.exec(text.split("\n").filter(l => !l.trimStart().startsWith(">")).join("\n"))
  need(!hit, `有占位符没填：${hit?.[0]}`)
  return { ok: errors.length === 0, errors, doc }
}

function acIds(ctx: LintContext): string[] | null {
  const ac = ctx.others?.["02"]?.machine?.ac
  return Array.isArray(ac) ? ac.map((x: Json) => x?.id).filter(Boolean) : null
}

function crossCheck(id: DocId, m: Json, doc: ParsedDoc, ctx: LintContext, need: Check): void {
  // open_questions 清零：流程里不向人提问，信息不足写 assumptions
  if (id === "01" || id === "02")
    need(!Array.isArray(m.open_questions) || m.open_questions.length === 0, "open_questions 必须清零（信息不足写进 assumptions，不要留给人回答）")

  // front-matter.inputs 引用的文档必须存在
  if (Array.isArray(doc.front.inputs)) {
    for (const ref of doc.front.inputs) {
      const key = String(ref).slice(0, 2)
      need(!(DOC_IDS as readonly string[]).includes(key) || Boolean(ctx.others?.[key as DocId]), `front-matter.inputs 引用的 ${ref} 不存在`)
    }
  }

  const known = acIds(ctx)
  const coverAll = (map: unknown, what: string): void => {
    if (!known || !isObject(map))
      return
    const missing = known.filter(ac => !(ac in map))
    const extra = Object.keys(map).filter(ac => !known.includes(ac))
    need(!missing.length, `${what} 没覆盖这些 AC：${missing.join(", ")}`)
    need(!extra.length, `${what} 里有 02 不存在的 AC：${extra.join(", ")}`)
  }

  if (id === "01" && ctx.docDir && Array.isArray(m.assets))
    m.assets.forEach((a: Json, i: number) => isObject(a) && lintAsset(ctx.docDir!, a, `machine.assets[${i}]`, need))

  if (id === "03") {
    coverAll(m.ac_coverage, "ac_coverage")
    if (ctx.implemented && ctx.projectRoot && isObject(m.ac_coverage)) {
      for (const [ac, v] of Object.entries(m.ac_coverage)) {
        for (const k of ["impl", "test"] as const) {
          const file = isObject(v) && typeof v[k] === "string" ? v[k].split("#")[0].trim() : ""
          need(!file || existsSync(join(ctx.projectRoot, file)), `ac_coverage.${ac}.${k} 指向的文件不存在：${file}`)
        }
      }
    }
    // 被 04 打回后重写：正文要有回应表，逐条回应每个 fix_required 的 R-x
    const review = ctx.others?.["04"]?.machine
    if (review?.verdict === "rejected" && Array.isArray(review.items)) {
      const rows = doc.body.split("\n").filter(l => l.trim().startsWith("|"))
      for (const item of review.items.filter((x: Json) => x?.fix_required))
        need(rows.some(r => new RegExp(`\\b${item.id}\\b`).test(r)), `回应表里没有回应 ${item.id}（被 04 打回后，03 正文要用表格逐条回应）`)
    }
  }

  if (id === "04" && known && Array.isArray(m.items)) {
    for (const item of m.items)
      need(item?.ac_ref == null || known.includes(item.ac_ref), `${item?.id}.ac_ref 引用的 ${item?.ac_ref} 在 02 里不存在`)
  }

  if (id === "05" || id === "06")
    coverAll(m.ac_status, "ac_status")
}

// ---------------- 素材 ----------------

export const ASSET_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]
export const ASSET_MAX_BYTES = 5 * 1024 * 1024

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

function lintAsset(docDir: string, a: Json, p: string, need: Check): void {
  const rel = String(a.path ?? "")
  const ext = extname(rel).toLowerCase()
  if (!/^assets\/[0-9a-f]{12}\.[a-z]+$/.test(rel)) { // 也挡住了 ../ 之类跳出文档目录的写法
    need(false, `${p}.path 必须形如 assets/<内容 sha256 前 12 位>.<扩展名>（当前 ${rel}）`)
    return
  }
  need(ASSET_EXTS.includes(ext), `${p}.path 只能是图片（${ASSET_EXTS.join(" ")}）`)
  const file = join(docDir, rel)
  if (!existsSync(file)) {
    need(false, `${p}.path 指向的文件不存在：${rel}`)
    return
  }
  need(statSync(file).size <= ASSET_MAX_BYTES, `${p} 超过 5 MB：${rel}`)
  const hash = sha256(file)
  need(rel.slice("assets/".length, "assets/".length + 12) === hash.slice(0, 12), `${p} 文件名与内容的 hash 不符：${rel}`)
  need(a.hash === hash, `${p}.hash 与文件内容不符`)
}

/** 把素材按内容 hash 存进文档目录的 assets/（同图只存一份）；返回 01 里要写的 path 和 hash。 */
export function storeAsset(docDir: string, src: string): { path: string, hash: string } {
  const ext = extname(src).toLowerCase()
  if (!ASSET_EXTS.includes(ext))
    throw new Error(`素材只收图片（${ASSET_EXTS.join(" ")}）：${src}`)
  if (statSync(src).size > ASSET_MAX_BYTES)
    throw new Error(`素材超过 5 MB：${src}`)
  const hash = sha256(src)
  const rel = `assets/${hash.slice(0, 12)}${ext}`
  const dst = join(docDir, rel)
  if (!existsSync(dst)) {
    mkdirSync(join(docDir, "assets"), { recursive: true })
    copyFileSync(src, dst)
  }
  return { path: rel, hash }
}

// ---------------- 版本历史 ----------------

/**
 * 覆盖前把现有版本存进 .agent/stages/<stage>/history/<文件名>.v<version>.md；
 * 没有 front-matter.version 时按已有历史顺延。返回存档路径，原文件不存在时返回 null。
 */
export function archiveDoc(id: DocId, path: string, stateDir: string): string | null {
  if (!existsSync(path))
    return null
  const text = readFileSync(path, "utf8")
  const dir = join(stateDir, "stages", DOCS[id].stage, "history")
  const stem = DOCS[id].file.replace(/\.md$/, "")
  let v = Number(parseDoc(text).front.version)
  if (!Number.isInteger(v) || v < 1) {
    v = 1
    while (existsSync(join(dir, `${stem}.v${v}.md`)))
      v++
  }
  const dst = join(dir, `${stem}.v${v}.md`)
  writeText(dst, text)
  return dst
}
