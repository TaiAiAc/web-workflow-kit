// 指标：主图里的 agent 调用与打回都记下来，按 agent 汇总。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { describe, it } from "node:test"
import { runPipeline } from "../src/graph.ts"
import { Metrics, metricsFile, summarize } from "../src/metrics.ts"
import { FAIL, FakeAgent, makeDeps, PASS, tempDir } from "./helpers.ts"

describe("指标", () => {
  it("主图：写代码、审阅、修复各记一次调用；门禁打回记在上一轮产出者头上", async () => {
    const tmp = tempDir()
    execFileSync("git", ["init", "-q"], { cwd: tmp })
    const { deps, cfg } = makeDeps(tmp, [FAIL, FAIL, PASS], { fixer: new FakeAgent() })
    deps.metrics = new Metrics(metricsFile(cfg.stateDir, "r1"))
    deps.agentNames = { coder: "claude", fixer: "dsh" }
    await runPipeline(deps, "做登录页")
    const calls = deps.metrics.events.filter(e => e.kind === "agent").map(e => e.kind === "agent" && [e.stage, e.role, e.agent, e.round])
    assert.deepEqual(calls, [
      ["implement", "dev", "claude", 1],
      ["gate", "review", "review", 1], ["gate", "fix", "dsh", 1],
      ["gate", "review", "review", 2], ["gate", "fix", "dsh", 2],
    ])
    const rejects = deps.metrics.events.filter(e => e.kind === "reject").map(e => e.kind === "reject" && [e.by, e.agent, e.round])
    assert.deepEqual(rejects, [["gate", "claude", 1], ["gate", "dsh", 2]])

    const sum = summarize(cfg.stateDir)
    assert.equal(sum.runs, 1)
    const claude = sum.agents.find(a => a.agent === "claude")!
    assert.deepEqual([claude.calls, claude.rejected], [1, { gate: 1 }])
    assert.equal(claude.top_reasons[0].reason, FAIL.failures[0].code)
    assert.equal(sum.agents.find(a => a.agent === "dsh")!.calls, 2)
  })

  it("汇总：token 只算拿得到用量的调用；按运行时间取最近几次", async () => {
    const state = join(tempDir(), ".agent")
    const old = new Metrics(metricsFile(state, "a"))
    old.agentCall("implement", "dev", "codex", 1, 1000, { stopReason: "end_turn", usage: { input: 100, output: 20, total: 120 } })
    await new Promise(r => setTimeout(r, 5)) // 两次运行的时间要分得出先后
    const recent = new Metrics(metricsFile(state, "b"))
    recent.agentCall("implement", "dev", "codex", 1, 3000, { stopReason: "error" })
    recent.agentCall("doc-review", "product", "codex", 1, 2000, { stopReason: "end_turn", usage: { input: 50, output: null, total: null } })
    recent.reject("tech-design", 1, "lint", "codex", ["front-matter 缺少 config_hash"])
    const all = summarize(state).agents[0]
    assert.equal(all.calls, 3)
    assert.equal(all.errors, 1)
    assert.deepEqual(all.tokens, { input: 150, output: 20, total: 170, calls_with_usage: 2 })
    assert.deepEqual(all.rejected, { lint: 1 })
    assert.deepEqual(all.roles.sort(), ["dev", "product"])
    assert.equal(summarize(state, { runs: 1 }).agents[0].calls, 2)
    assert.deepEqual(summarize(join(tempDir(), "none")), { runs: 0, agents: [] })
  })
})
