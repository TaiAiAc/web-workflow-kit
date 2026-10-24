// 修复审阅后端：auto / api / dsh / skip，以及 dsh 审阅的只读校验。
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import process from "node:process"
import { beforeEach, describe, it } from "node:test"
import { loadConfig } from "../src/config.ts"
import { defaultDeps, depsFromState } from "../src/deps.ts"
import { LLMError } from "../src/llm.ts"
import { extractPlan, resolveBackend } from "../src/review.ts"
import { tempDir } from "./helpers.ts"

const PAYLOAD = { failures: [{ code: "TYPECHECK_FAIL", check: "typecheck", message: "x", locations: ["src/a.ts:1"] }], diff_hunks: [] }

// 假 dsh：先打几行日志（含无关的花括号），再输出计划；FAKE_DSH_WRITE 指定时还会偷偷改文件
const FAKE_DSH = `
import { writeFileSync } from "node:fs"
console.log("dsh 0.9 booting {profile: headless}")
console.log("reading task…")
if (process.env.FAKE_DSH_WRITE) writeFileSync(process.env.FAKE_DSH_WRITE, "oops")
console.log(JSON.stringify({ verdict: "fixable", summary: "类型不匹配", pass: true,
  fixes: [{ code: "TYPECHECK_FAIL", file: "src/a.ts", line: 1, instruction: "改类型", confidence: 0.8 }] }))
console.log("done.")
`

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  const set = (v: Record<string, string | undefined>) => Object.entries(v).forEach(([k, x]) => (x === undefined ? delete process.env[k] : (process.env[k] = x)))
  set(vars)
  try {
    const r = fn()
    if (r instanceof Promise)
      return r.finally(() => set(old)) as T
    set(old)
    return r
  }
  catch (e) {
    set(old)
    throw e
  }
}

describe("选择审阅后端", () => {
  it("auto：有 Key 用 API，否则有 dsh 用 dsh，否则跳过", () => {
    const root = tempDir()
    const cfg = loadConfig(root)
    withEnv({ DEEPSEEK_API_KEY: "k" }, () => assert.equal(resolveBackend(cfg)[0], "api"))
    withEnv({ DEEPSEEK_API_KEY: undefined }, () => {
      cfg.raw.review.dsh_command = [process.execPath, "x.mjs", "{prompt}"]
      assert.deepEqual(resolveBackend(cfg), ["dsh", "未配置 API Key，本机有 dsh"])
      cfg.raw.review.dsh_command = ["definitely-not-installed-dsh", "{prompt}"]
      assert.equal(resolveBackend(cfg)[0], "skip")
    })
  })

  it("手动指定与未知值", () => {
    const cfg = loadConfig(tempDir())
    assert.deepEqual(resolveBackend(cfg, "skip"), ["skip", "手动指定"])
    assert.throws(() => resolveBackend(cfg, "gpt"), /未知的审阅方式/)
  })

  it("从混着日志的输出里取计划", () => {
    const text = "boot {profile: x}\n{\"note\": 1}\n{\"verdict\": \"fixable\", \"fixes\": []}\ntrailing"
    assert.equal(extractPlan(text).verdict, "fixable")
    assert.throws(() => extractPlan("no json here {"), LLMError)
  })
})

describe("运行审阅", () => {
  let root: string
  beforeEach(() => {
    root = tempDir()
    const script = join(root, "..", `fake_dsh_${root.split(/[\\/]/).pop()}.mjs`)
    writeFileSync(script, FAKE_DSH)
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({ review: { dsh_command: [process.execPath, script, "{prompt}"] } }))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "a.ts"), "let a: number = 'x'")
  })
  const reviewer = (choice: string) => defaultDeps(loadConfig(root), { reviewBackend: choice, log: () => {} }).reviewer

  it("skip", async () => {
    const plan = await reviewer("skip")(PAYLOAD)
    assert.deepEqual([plan.verdict, plan.reviewer], ["unavailable", "skip"])
  })

  it("dsh：解析计划并去掉 pass，任务文件写明只读", async () => {
    const plan = await reviewer("dsh")(PAYLOAD)
    assert.deepEqual([plan.verdict, plan.reviewer], ["fixable", "dsh"])
    assert.equal("pass" in plan, false) // 顾问无放行权
    assert.equal(plan.fixes[0].file, "src/a.ts")
    const task = readFileSync(join(root, ".agent", "review-task.md"), "utf8")
    assert.match(task, /TYPECHECK_FAIL/)
    assert.match(task, /只读/)
  })

  it("dsh 审阅改了文件：判违规，交给人", async () => {
    const plan = await withEnv({ FAKE_DSH_WRITE: join(root, "src", "a.ts") }, () => reviewer("dsh")(PAYLOAD))
    assert.equal(plan.verdict, "needs_human") // → 熔断
    assert.deepEqual(plan.violation, ["src/a.ts"])
    assert.match(plan.summary, /违规改动了文件：src\/a\.ts/)
  })

  it("API：带 Key、强制 JSON 输出，去掉 pass", async () => {
    const seen: { auth?: string, body?: any } = {}
    const server = createServer((req, res) => {
      let raw = ""
      req.on("data", c => (raw += c))
      req.on("end", () => {
        seen.auth = req.headers.authorization
        seen.body = JSON.parse(raw)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "fixable", pass: true, fixes: [] }) } }] }))
      })
    })
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({ review: { base_url: `http://127.0.0.1:${port}` } }))
    try {
      const plan = await withEnv({ DEEPSEEK_API_KEY: "sk-test", NO_PROXY: "127.0.0.1" }, () => reviewer("api")(PAYLOAD))
      assert.deepEqual([plan.verdict, plan.reviewer], ["fixable", "api"])
      assert.equal("pass" in plan, false)
      assert.equal(seen.auth, "Bearer sk-test")
      assert.deepEqual(seen.body.response_format, { type: "json_object" })
    }
    finally {
      server.close()
    }
  })

  it("服务端按输入选审阅方式", async () => {
    const deps = depsFromState({ project_root: root, review_backend: "skip" })
    assert.equal((await deps.reviewer(PAYLOAD)).reviewer, "skip")
  })
})
