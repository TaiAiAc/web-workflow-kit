#!/usr/bin/env node
// 一键跑全部场景：门禁场景直接调 verify.mjs 对比 expected.json；
// fixloop 场景跑一次修复回环：--python 走 Python 版（tools/run-fixloop.py），
// --core 走 TS 核心（<core>/src/cli.ts fix --json，需先在 core/ 里 pnpm install）；两者都给时用 TS 核心。
//
// 用法：
//   node run-all.mjs --verify <kit>/assets/verify.mjs \
//                    [--python <venv python> | --core <kit>/core] [--only 02,03] [--verbose]
// 环境变量：WWK_VERIFY / WWK_PYTHON / WWK_CORE 同义。
//
// 退出码：0 全通过 / 1 有失败 / 2 用法或环境错误。
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const verbose = argv.includes("--verbose")
const only = (flag("--only") || "").split(",").map(s => s.trim()).filter(Boolean)

function pickVerify() {
  const cands = [flag("--verify"), process.env.WWK_VERIFY, join(here, "verify.mjs")].filter(Boolean)
  for (const c of cands) {
    const p = resolve(here, c)
    if (existsSync(p)) return p
  }
  console.error("找不到 verify.mjs。用 --verify <path> 或环境变量 WWK_VERIFY 指定（见 README.md）")
  process.exit(2)
}

function pickPython() {
  for (const c of [flag("--python"), process.env.WWK_PYTHON].filter(Boolean)) {
    const p = resolve(here, c)
    if (existsSync(p)) return p
  }
  return null
}

function pickCore() {
  for (const c of [flag("--core"), process.env.WWK_CORE].filter(Boolean)) {
    const dir = resolve(here, c)
    const tsx = join(dir, "node_modules", "tsx", "dist", "cli.mjs")
    if (existsSync(join(dir, "src", "cli.ts")) && existsSync(tsx)) return { cli: join(dir, "src", "cli.ts"), tsx }
    console.error(`--core ${c}：找不到 src/cli.ts 或 node_modules/tsx（先在 core/ 里 pnpm install）`)
    process.exit(2)
  }
  return null
}

const verifyMjs = pickVerify()
const python = pickPython()
const core = pickCore()
const tmp = mkdtempSync(join(tmpdir(), "wwk-fx-"))
const rows = []
let bad = 0

// 场景目录在多次运行之间会被改（构建产物、修复脚本写的文件），
// expected.json 的 reset 列出需要先清掉的东西，保证每次从同一初始状态开始。
function reset(dir, list = []) {
  for (const rel of list) {
    const target = join(dir, rel)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
  }
}

function gate(dir) {
  const out = join(tmp, dir.replace(/[\\/]/g, "_") + ".json")
  const r = spawnSync(process.execPath, [verifyMjs, "--cwd", dir, "--out", out, "--json"], { encoding: "utf8" })
  let report = null
  try { report = JSON.parse(r.stdout) } catch { report = null }
  return { exit: r.status ?? -1, report, raw: `${r.stdout || ""}${r.stderr || ""}` }
}

function fixloop(dir) {
  const r = core
    ? spawnSync(process.execPath, [core.tsx, core.cli, "fix", "--project", dir, "--json"], { encoding: "utf8", cwd: here })
    : spawnSync(python, [join(here, "tools", "run-fixloop.py"), dir], { encoding: "utf8", cwd: here })
  let state = null
  try { state = JSON.parse((r.stdout || "").trim()) } catch { state = null }
  return { exit: r.status ?? -1, state, raw: `${r.stdout || ""}${r.stderr || ""}` }
}

const codesOf = (report) => [...new Set((report?.failures ?? []).map(f => f.code))].sort()

function compareGate(expected, actual) {
  const problems = []
  if (actual.exit !== expected.exit) problems.push(`退出码 ${actual.exit}，期望 ${expected.exit}`)
  const got = codesOf(actual.report)
  const want = [...new Set(expected.codes ?? [])].sort()
  if (got.join(",") !== want.join(",")) problems.push(`失败码 [${got.join(",")}]，期望 [${want.join(",")}]`)

  for (const [id, st] of Object.entries(expected.statuses ?? {})) {
    const c = (actual.report?.checks ?? []).find(x => x.id === id)
    if (!c) problems.push(`报告里没有 check ${id}`)
    else if (c.status !== st) problems.push(`check ${id} 是 ${c.status}，期望 ${st}`)
  }

  // reasons：被跳过的检查为什么被跳过（依赖失败 / fail_fast），只出现在 checks 上，不在失败项里
  for (const [id, reason] of Object.entries(expected.reasons ?? {})) {
    const c = (actual.report?.checks ?? []).find(x => x.id === id)
    if (c && !String(c.reason ?? "").includes(reason)) problems.push(`check ${id} 的 reason 是「${c.reason ?? ""}」，期望含「${reason}」`)
  }

  // locations：门禁从输出里抽出的“出错位置”，是下游修复 agent 的定位依据
  const locations = (actual.report?.failures ?? []).flatMap(f => f.locations ?? [])
  for (const loc of expected.locations ?? []) {
    if (!locations.includes(loc)) problems.push(`缺 locations ${loc}（实际 [${locations.join(", ")}]）`)
  }

  // messages：失败项 message / detail 里必须出现的关键字，用来锁住失败原因的语义
  const text = (actual.report?.failures ?? []).map(f => `${f.message ?? ""}\n${f.detail ?? ""}`).join("\n")
  for (const msg of expected.messages ?? []) {
    if (!text.includes(msg)) problems.push(`失败项里找不到「${msg}」`)
  }
  return problems
}

function compareFixloop(expected, state) {
  const problems = []
  if ((state.status ?? "") !== expected.status) problems.push(`status ${state.status ?? "<空>"}，期望 ${expected.status}`)
  if (expected.break_reason && !String(state.break_reason ?? "").startsWith(expected.break_reason))
    problems.push(`break_reason ${state.break_reason ?? "<空>"}，期望前缀 ${expected.break_reason}`)
  if (expected.attempt != null && state.attempt !== expected.attempt)
    problems.push(`attempt ${state.attempt}，期望 ${expected.attempt}`)
  return problems
}

for (const name of readdirSync(join(here, "scenarios")).sort()) {
  if (only.length && !only.some(o => name.startsWith(o))) continue
  const dir = join(here, "scenarios", name)
  if (!statSync(dir).isDirectory()) continue
  const file = join(dir, "expected.json")
  if (!existsSync(file)) continue
  const expected = JSON.parse(readFileSync(file, "utf8"))
  const title = `${expected.desc ?? ""}`
  reset(dir, expected.reset)

  if ((expected.kind ?? "gate") === "fixloop") {
    if (!python && !core) {
      rows.push({ ok: null, name, title, detail: "跳过（没给 --python 或 --core，fixloop 场景要跑修复回环）" })
      continue
    }
    const r = fixloop(dir)
    if (!r.state) {
      bad++
      rows.push({ ok: false, name, title, detail: `没拿到结果（退出码 ${r.exit}）：${r.raw.slice(-400)}` })
      continue
    }
    const problems = compareFixloop(expected, r.state)
    if (problems.length) bad++
    rows.push({
      ok: problems.length === 0,
      name,
      title,
      detail: problems.length ? problems.join("；")
        : `status=${r.state.status} attempt=${r.state.attempt}${r.state.break_reason ? " " + r.state.break_reason : ""}`,
    })
    if (problems.length && verbose) console.log(`\n--- ${name} 输出 ---\n${r.raw}\n`)
    continue
  }

  const actual = gate(dir)
  const problems = compareGate(expected, actual)
  if (problems.length) bad++
  const got = codesOf(actual.report)
  rows.push({
    ok: problems.length === 0,
    name,
    title,
    detail: problems.length ? problems.join("；") : `exit ${actual.exit}${got.length ? " " + got.join(",") : " 无失败项"}`,
  })
  if (problems.length && verbose) console.log(`\n--- ${name} 门禁输出 ---\n${actual.raw}\n`)
}

const width = Math.max(...rows.map(r => r.name.length)) + 2
console.log("\n场景结果")
console.log("-".repeat(78))
for (const r of rows) {
  console.log(`${r.ok === null ? "○" : r.ok ? "✔" : "✘"} ${r.name.padEnd(width)} ${r.title}`)
  console.log(`  ${r.detail}`)
}
console.log("-".repeat(78))
const okCount = rows.filter(r => r.ok === true).length
const skipCount = rows.filter(r => r.ok === null).length
console.log(`通过 ${okCount} / 失败 ${bad} / 跳过 ${skipCount}（共 ${rows.length} 个场景）`)
rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
