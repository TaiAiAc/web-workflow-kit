// 用假 agent / 假门禁跑通主图与两个子图。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"
import { ERROR } from "../src/agents.ts"
import { validatePlan } from "../src/deps.ts"
import { changedHunks, snapshot, splitHunks } from "../src/diffs.ts"
import { GateResult } from "../src/gate.ts"
import { lastThread, openCheckpointer } from "../src/checkpoint.ts"
import { buildMainGraph, explainBreak, resume, routeAfterVerify, runFixLoop, runPipeline } from "../src/graph.ts"
import * as N from "../src/names.ts"
import { markSent, shouldSend } from "../src/notify.ts"
import type { State } from "../src/state.ts"
import { resolveWorkflow, WORKFLOW_DEFAULTS } from "../src/config.ts"
import { stagePlan } from "../src/workflow.ts"
import { FAIL, FakeAgent, makeDeps, PASS, tempDir } from "./helpers.ts"

describe("主图", () => {
  let tmp: string
  beforeEach(() => {
    tmp = tempDir()
    execFileSync("git", ["init", "-q"], { cwd: tmp })
  })

  it("一次全绿：直接交付，不审阅不修复", async () => {
    const fixer = new FakeAgent()
    const { deps, sent, cfg } = makeDeps(tmp, [PASS], { fixer })
    const s = await runPipeline(deps, "做个登录页")
    assert.equal(s.status, "delivered")
    assert.deepEqual(fixer.calls, []) // 零 token：脚本全绿直接结束
    assert.deepEqual(sent, [])
    assert.ok(existsSync(join(cfg.stateDir, "delivery.json")))
    assert.ok(existsSync(join(cfg.stateDir, "spec.md")))
  })

  it("失败 → 修复 → 通过", async () => {
    const fixer = new FakeAgent()
    const { deps } = makeDeps(tmp, [FAIL, PASS], { fixer })
    const s = await runPipeline(deps, "req")
    assert.equal(s.status, "delivered")
    assert.equal(fixer.calls.length, 1)
    assert.match(fixer.calls[0], /TYPECHECK_FAIL/)
    assert.deepEqual(s.history.map(h => h.exit), [1, 0])
  })

  it("修复上限由代码强制", async () => {
    const fixer = new FakeAgent()
    const { deps, sent } = makeDeps(tmp, Array.from({ length: 10 }, () => FAIL), { fixer, maxRetries: 2 })
    const s = await runPipeline(deps, "req")
    assert.equal(s.status, "broken")
    assert.equal(fixer.calls.length, 2)
    assert.ok(s.break_reason.startsWith("RETRY_LIMIT"))
    assert.equal(sent.length, 1)
  })

  it("顾问无放行权：计划里带 pass 也不能越过门禁", async () => {
    const { deps } = makeDeps(tmp, [FAIL, FAIL], { plan: { verdict: "fixable", pass: true, fixes: [] }, maxRetries: 1 })
    assert.equal((await runPipeline(deps, "req")).status, "broken")
  })

  it("顾问判定需要人：立刻熔断，不修复", async () => {
    const fixer = new FakeAgent()
    const { deps, sent } = makeDeps(tmp, [FAIL], { plan: { verdict: "needs_human", summary: "证书", fixes: [] }, fixer })
    const s = await runPipeline(deps, "req")
    assert.equal(s.status, "broken")
    assert.deepEqual(fixer.calls, [])
    assert.equal(sent.length, 1)
    assert.match(s.summary, /验收顾问判断需要人来决定（证书）/)
  })

  it("门禁规则错误（退出码 2）直接熔断", async () => {
    const { deps } = makeDeps(tmp, [new GateResult(2, [{ code: "CONFIG_ERROR", check: "rules", message: "m" }])])
    assert.equal((await runPipeline(deps, "req")).break_reason, "GATE_CONFIG_ERROR")
  })

  it("设计稿读取失败：停下，不生成 Spec，不发邮件", async () => {
    const { deps, sent } = makeDeps(tmp, [])
    deps.design = async () => {
      throw new Error("MasterGo get_selection_node: ❌ 没有选中图层")
    }
    const s = await runPipeline(deps, "req", "mastergo")
    assert.ok(s.break_reason.startsWith("DESIGN_ERROR"))
    assert.equal(s.spec, undefined)
    assert.deepEqual(sent, [])
    assert.match(s.summary, /属于本地操作问题，未发邮件/)
  })

  it("编码 agent 出错：门禁前熔断", async () => {
    const { deps } = makeDeps(tmp, [], { coder: new FakeAgent(ERROR) })
    assert.ok((await runPipeline(deps, "req")).break_reason.startsWith("CODE_AGENT_ERROR"))
  })

  it("修复 agent 出错：熔断", async () => {
    const { deps } = makeDeps(tmp, [FAIL], { fixer: new FakeAgent(ERROR) })
    const s = await runPipeline(deps, "req")
    assert.ok(s.break_reason.startsWith("FIX_AGENT_ERROR"))
  })

  it("修复回环跳过编码", async () => {
    const coder = new FakeAgent()
    const { deps } = makeDeps(tmp, [FAIL, PASS], { coder })
    const s = await runFixLoop(deps)
    assert.equal(s.status, "delivered")
    assert.deepEqual(coder.calls, [])
    assert.match(s.summary, /工作区有 0 个未提交的改动文件，经过 1 轮自动修复/)
  })

  it("崩溃后从检查点继续：已完成的编码不重跑，已结束的线程直接返回", async () => {
    const coder = new FakeAgent()
    const { deps, cfg } = makeDeps(tmp, [], { coder })
    const calls: (Error | GateResult)[] = [new Error("process killed"), PASS]
    deps.gate = async () => {
      const r = calls.shift()!
      if (r instanceof Error)
        throw r
      return r
    }
    await assert.rejects(runPipeline(deps, "req"), /process killed/)
    assert.ok(existsSync(join(cfg.stateDir, "checkpoints.sqlite")))
    assert.ok(lastThread(cfg)?.startsWith("code-"))
    const s = await resume(deps)
    assert.equal(s.status, "delivered")
    assert.equal(coder.calls.length, 1) // codegraph 不会重跑
    assert.equal((await resume(deps)).status, "delivered") // 已结束的线程直接返回
    await assert.rejects(resume(deps, "bogus-1"), /unknown thread id/)
  })

  it("检查点落盘：换一个进程（新的 saver）也读得回来", async () => {
    const { deps, cfg } = makeDeps(tmp, [FAIL, PASS])
    const s = await runFixLoop(deps)
    const cp = (await openCheckpointer(cfg))!
    try {
      const graph = buildMainGraph(deps, "verify", { checkpointer: cp.saver })
      const snap = await graph.getState({ configurable: { thread_id: lastThread(cfg)! } })
      assert.equal((snap.values as typeof s).status, "delivered")
      assert.deepEqual((snap.values as typeof s).history.map(h => h.exit), [1, 0])
    }
    finally {
      cp.close()
    }
  })

  it("关掉检查点：不落盘，也不能恢复", async () => {
    const { deps, cfg } = makeDeps(tmp, [PASS])
    cfg.raw.checkpoint = { enabled: false }
    assert.equal((await runFixLoop(deps)).status, "delivered")
    assert.equal(existsSync(join(cfg.stateDir, "checkpoints.sqlite")), false)
    await assert.rejects(resume(deps, "verify-1"), /resume needs checkpoints/)
  })

  it("路由", () => {
    const s = (v: Partial<State>) => v as State
    assert.equal(routeAfterVerify(s({ verify_exit: 0, attempt: 9 }), 3), N.DELIVER)
    assert.equal(routeAfterVerify(s({ verify_exit: 1, attempt: 3 }), 3), N.REVIEW)
    assert.equal(routeAfterVerify(s({ verify_exit: 1, attempt: 4 }), 3), N.BREAKER)
    assert.equal(routeAfterVerify(s({ verify_exit: 2, attempt: 1 }), 3), N.BREAKER)
  })

  it("两种入口都能编译", () => {
    const { deps } = makeDeps(tmp, [])
    buildMainGraph(deps)
    buildMainGraph(deps, "verify")
  })

  it("子步骤随 subgraphs 流式上报（控制台按此画进度）", async () => {
    const { deps } = makeDeps(tmp, [FAIL, PASS])
    const graph = buildMainGraph(deps)
    const steps: string[] = []
    for await (const [ns, mode, chunk] of await graph.stream({ requirement: "r", project_root: tmp, attempt: 0 },
      { streamMode: ["tasks"], subgraphs: true })) {
      if (mode === "tasks" && "input" in (chunk as object))
        steps.push([...(ns as string[]).map(n => n.split(":")[0]), (chunk as { name: string }).name].join("/"))
    }
    assert.deepEqual(steps, [
      N.DISCOVERY, N.TECH_DESIGN, N.DOC_REVIEW, // 尚未实现的阶段：跳过节点
      N.CODE, `${N.CODE}/${N.DESIGN}`, `${N.CODE}/${N.SPEC}`, `${N.CODE}/${N.WRITE_CODE}`,
      N.VERIFY, N.REVIEW, `${N.REVIEW}/${N.ADVISE}`, `${N.REVIEW}/${N.FIX}`, N.VERIFY, N.ACCEPTANCE, N.DELIVER,
    ])
  })

  it("阶段按配置拼：关掉的不出现，没实现的跳过并记 skipped", async () => {
    const { deps } = makeDeps(tmp, [PASS])
    deps.cfg.workflow.raw.stages.discovery.enabled = false
    deps.cfg.workflow.raw.stages["doc-review"].enabled = false
    const graph = buildMainGraph(deps)
    const steps: string[] = []
    let final: State | undefined
    for await (const [mode, chunk] of await graph.stream({ requirement: "r", project_root: tmp, attempt: 0 },
      { streamMode: ["tasks", "values"] })) { // 不开 subgraphs：只看主图上的阶段
      if (mode === "tasks" && "input" in (chunk as object))
        steps.push((chunk as { name: string }).name)
      if (mode === "values")
        final = chunk as State
    }
    assert.deepEqual(steps, [N.TECH_DESIGN, N.CODE, N.VERIFY, N.ACCEPTANCE, N.DELIVER])
    assert.deepEqual(final?.stage_status, { "tech-design": "skipped", "implement": "done", "gate": "done", "acceptance": "skipped" })
    assert.equal(final?.status, "delivered")
  })

  it("门禁熔断时 gate 记 failed；修复回环只走门禁", async () => {
    const { deps } = makeDeps(tmp, [FAIL, FAIL], { maxRetries: 1 })
    const s = await runFixLoop(deps)
    assert.equal(s.status, "broken")
    assert.deepEqual(s.stage_status, { gate: "failed" })
    assert.deepEqual(stagePlan(deps.cfg.workflow, "verify").map(p => p.name), ["gate"])
  })

  it("stagePlan 按 order 排、跳过关掉的，并标出哪些已实现", () => {
    const wf = resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["workspace", { stages: { acceptance: { enabled: false } } }]])
    const plan = stagePlan(wf)
    assert.deepEqual(plan.map(p => p.name), ["discovery", "tech-design", "doc-review", "implement", "gate"])
    assert.deepEqual(plan.filter(p => p.implemented).map(p => p.node), [N.CODE, N.VERIFY])
  })

  it("熔断说明", () => {
    const s = { break_reason: "RETRY_LIMIT: 3 fix round(s) exhausted", failures: [{ code: "LINT_FAIL" }, { code: "BUILD_FAIL" }] } as unknown as State
    assert.equal(explainBreak(s, "skipped(SMTP_HOST/NOTIFY_EMAIL not set)"),
      "已熔断：已自动修复到上限仍未通过门禁。门禁失败项：BUILD_FAIL, LINT_FAIL。未发邮件（未配置 SMTP 或发送失败）。需要人工介入。")
    assert.match(explainBreak(s, "deduped"), /24 小时内已就同类问题发过邮件/)
  })
})

describe("单元", () => {
  it("校验计划：去掉 pass，拒绝非法 verdict", () => {
    assert.equal("pass" in validatePlan({ verdict: "fixable", pass: true }), false)
    assert.throws(() => validatePlan({ verdict: "approved" }))
  })

  it("熔断邮件去重窗口", () => {
    const cache = join(tempDir(), ".notify_cache")
    assert.ok(shouldSend(cache, "k", 24, 1000))
    markSent(cache, "k", 24, 1000)
    assert.equal(shouldSend(cache, "k", 24, 1000 + 3600), false)
    assert.ok(shouldSend(cache, "k", 24, 1000 + 24 * 3600))
  })

  it("只取改动块（含新文件）", () => {
    const root = tempDir()
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root })
    git("init", "-q")
    writeFileSync(join(root, "a.ts"), Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n") + "\n")
    git("add", ".")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    const base = snapshot(root)
    writeFileSync(join(root, "a.ts"), readFileSync(join(root, "a.ts"), "utf8").replace("line50", "changed50"))
    writeFileSync(join(root, "new.ts"), "export {}\n")
    const hunks = changedHunks(root, base, [])
    assert.deepEqual(new Set(hunks.map(h => h.file)), new Set(["a.ts", "new.ts"]))
    assert.ok(hunks.find(h => h.file === "a.ts")!.patch.length < 200)
    assert.equal(hunks.find(h => h.file === "new.ts")!.patch, "+export {}")
    assert.deepEqual(splitHunks(""), [])
  })
})
