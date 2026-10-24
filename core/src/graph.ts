// 主图（平铺）：按工作流配置启用的阶段依次串起来——… → 编码（codegraph）→ 门禁 ⇄ 审阅修复（reviewgraph）→ … → 交付 | 熔断。
// 放行只看 verify_exit == 0；熔断由 attempt 计数在代码里强制，与模型输出无关。
import { relative } from "node:path"
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from "@langchain/langgraph"
import { END, START, StateGraph } from "@langchain/langgraph"
import { END_TURN, ERROR } from "./agents.ts"
import { type Entry, entryOf, lastThread, newThreadId, openCheckpointer, remember } from "./checkpoint.ts"
import { readUserWorkflow, resolveWorkflow, type Workflow, WORKFLOW_DEFAULTS, writeText } from "./config.ts"
import { codePrompt, type Deps, fixPrompt } from "./deps.ts"
import { changedHunks, snapshot } from "./diffs.ts"
import * as N from "./names.ts"
import { PipelineState, type State, type Update } from "./state.ts"
import { type StageName, stagePlan, STAGES } from "./workflow.ts"

/** 固定的 Deps（CLI / 测试），或按 state 现建 Deps 的函数（控制台 / 服务端）。 */
export type Source = Deps | ((state: State) => Deps)
const resolveDeps = (source: Source, state: State): Deps => (typeof source === "function" ? source(state) : source)

// 子图输出只回传自己负责的字段，避免 history 这类累加字段被重复合并
const CODE_KEYS = ["design", "spec", "baseline", "code_stop_reason", "break_reason"] as const
const REVIEW_KEYS = ["plan", "fix_stop_reason", "break_reason"] as const
function pick(state: State, keys: readonly (keyof State)[]): Update {
  return Object.fromEntries(keys.filter(k => state[k] !== undefined).map(k => [k, state[k]])) as Update
}

export function buildCodeGraph(source: Source) {
  return new StateGraph(PipelineState)
    .addNode(N.DESIGN, async (state) => {
      const { log, design } = resolveDeps(source, state)
      if (!state.design_ref)
        return { design: null }
      try {
        const d = await design(state.design_ref)
        log(`[读取设计稿] 已读取 ${state.design_ref}`)
        return { design: d }
      }
      catch (e) { // 明确指定了设计稿却读不到：停下，别让 Spec 凭空编
        log(`[读取设计稿] 失败：${(e as Error).message}`)
        return { design: null, break_reason: `DESIGN_ERROR: ${(e as Error).message}` }
      }
    })
    .addNode(N.SPEC, async (state) => {
      const { cfg, log, spec } = resolveDeps(source, state)
      log("[生成Spec] 生成中…")
      let text: string
      try {
        text = await spec(state.requirement, state.design ?? null)
      }
      catch (e) {
        return { break_reason: `SPEC_ERROR: ${(e as Error).message}` }
      }
      const file = `${cfg.stateDir}/spec.md`
      writeText(file, text)
      log(`[生成Spec] 已写入 ${file}`)
      return { spec: text }
    })
    .addNode(N.WRITE_CODE, async (state) => {
      const deps = resolveDeps(source, state)
      const { cfg, log, coder } = deps
      const baseline = snapshot(cfg.projectRoot)
      log("[写代码] 编码 agent 工作中…")
      const t = Date.now()
      const r = await coder.run(codePrompt(state.requirement, state.spec), cfg.projectRoot)
      deps.metrics?.agentCall("implement", "dev", deps.agentNames?.coder ?? "coder", 1, Date.now() - t, r)
      log(`[写代码] 结束，stop_reason=${r.stopReason}`)
      const out: Update = { baseline, code_stop_reason: r.stopReason }
      if (r.stopReason === ERROR)
        out.break_reason = `CODE_AGENT_ERROR: ${r.text.slice(-500)}`
      else if (r.stopReason !== END_TURN)
        log("[写代码] agent 提前停止，交给门禁判定")
      return out
    })
    .addEdge(START, N.DESIGN)
    .addConditionalEdges(N.DESIGN, s => (s.break_reason ? END : N.SPEC), [N.SPEC, END])
    .addConditionalEdges(N.SPEC, s => (s.break_reason ? END : N.WRITE_CODE), [N.WRITE_CODE, END])
    .addEdge(N.WRITE_CODE, END)
    .compile({ name: N.CODEGRAPH_NAME })
}

export function buildReviewGraph(source: Source) {
  return new StateGraph(PipelineState)
    .addNode(N.ADVISE, async (state) => {
      const deps = resolveDeps(source, state)
      const { cfg, log, reviewer } = deps
      const failures = state.failures ?? []
      const dcfg = cfg.get("diff")
      const payload = {
        project_type: cfg.get("verify").type || "见 rules.yaml",
        attempt: state.attempt ?? 1,
        max_attempts: cfg.maxRetries,
        requirement: state.requirement ?? "",
        spec_excerpt: (state.spec ?? "").slice(0, 2000),
        failures,
        diff_hunks: changedHunks(cfg.projectRoot, state.baseline, failures,
          Number(dcfg.max_chars ?? 12000), Number(dcfg.context_lines ?? 3)),
      }
      log(`[验收审阅] ${failures.length} 个失败项、${payload.diff_hunks.length} 个改动块 → 验收顾问`)
      const t = Date.now()
      const plan = await reviewer(payload)
      deps.metrics?.agentCall("gate", "review", plan.reviewer ?? "review", state.attempt ?? 1, Date.now() - t,
        { stopReason: plan.verdict === "unavailable" ? "error" : "end_turn" })
      log(`[验收审阅] 结论 ${plan.verdict}（经 ${plan.reviewer ?? "?"}）：${plan.summary ?? ""}`)
      const out: Update = { plan }
      if (plan.verdict === "needs_human")
        out.break_reason = `NEEDS_HUMAN: ${plan.summary ?? ""}`
      return out
    })
    .addNode(N.FIX, async (state) => {
      const deps = resolveDeps(source, state)
      const { cfg, log, fixer } = deps
      log("[执行修复] 修复 agent 工作中…")
      const t = Date.now()
      const r = await fixer.run(fixPrompt(state.attempt ?? 1, cfg.maxRetries, state.failures ?? [], state.plan), cfg.projectRoot)
      deps.metrics?.agentCall("gate", "fix", deps.agentNames?.fixer ?? "fixer", state.attempt ?? 1, Date.now() - t, r)
      log(`[执行修复] 结束，stop_reason=${r.stopReason}`)
      const out: Update = { fix_stop_reason: r.stopReason }
      if (r.stopReason === ERROR)
        out.break_reason = `FIX_AGENT_ERROR: ${r.text.slice(-500)}`
      return out
    })
    .addEdge(START, N.ADVISE)
    .addConditionalEdges(N.ADVISE, s => (s.break_reason ? END : N.FIX), [N.FIX, END])
    .addEdge(N.FIX, END)
    .compile({ name: N.REVIEWGRAPH_NAME })
}

export function routeAfterVerify(state: State, maxRetries: number): string {
  const exit = state.verify_exit ?? 1
  if (exit === 0)
    return N.DELIVER
  if (exit === 2)
    return N.BREAKER            // 规则/环境错误：模型无权也无法修
  if ((state.attempt ?? 0) > maxRetries)
    return N.BREAKER            // 已修复 maxRetries 轮仍失败
  return N.REVIEW
}

// break_reason 前缀 → 给人看的中文说明
const BREAK_EXPLAINED: Record<string, string> = {
  GATE_CONFIG_ERROR: "门禁规则或运行环境有误（verify 退出码 2），模型无权也无法修复，请检查 rules.yaml 和 Node 环境",
  RETRY_LIMIT: "已自动修复到上限仍未通过门禁",
  NEEDS_HUMAN: "验收顾问判断需要人来决定",
  DESIGN_ERROR: "设计稿读取失败",
  SPEC_ERROR: "Spec 生成失败",
  CODE_AGENT_ERROR: "编码 agent 出错",
  FIX_AGENT_ERROR: "修复 agent 出错",
  WHITELIST_VIOLATION: "agent 改了这个阶段不允许改的文件（提交路径白名单），运行中止",
  COMMIT_ERROR: "阶段提交失败",
}
const NOTIFY_EXPLAINED: Record<string, string> = { sent: "已发熔断邮件", deduped: "24 小时内已就同类问题发过邮件，本次不重复发送" }

export function explainBreak(state: State, notify: string): string {
  const reason = state.break_reason ?? ""
  const i = reason.indexOf(":")
  const key = i < 0 ? reason : reason.slice(0, i)
  const detail = i < 0 ? "" : reason.slice(i + 1).trim()
  let text = `已熔断：${BREAK_EXPLAINED[key] ?? (reason || "原因未知")}`
  if (detail && ["NEEDS_HUMAN", "DESIGN_ERROR", "SPEC_ERROR", "WHITELIST_VIOLATION", "COMMIT_ERROR"].includes(key))
    text += `（${detail.slice(0, 200)}）`
  const codes = [...new Set((state.failures ?? []).map(f => f.code ?? "?"))].sort()
  if (codes.length)
    text += `。门禁失败项：${codes.join(", ")}`
  if (notify.startsWith("skipped(local"))
    text += "。属于本地操作问题，未发邮件"
  else if (notify.startsWith("skipped"))
    text += "。未发邮件（未配置 SMTP 或发送失败）"
  else
    text += `。${NOTIFY_EXPLAINED[notify] ?? notify}`
  return text + "。需要人工介入。"
}

export interface MainGraphOptions {
  checkpointer?: BaseCheckpointSaver
  /** 拼图用的工作流配置。不给时：固定 Deps 用它自己项目的；按 state 现建 Deps 的（Studio）用包内默认 + 通用配置 */
  workflow?: Workflow
}

function workflowFor(source: Source, workflow?: Workflow): Workflow {
  if (workflow)
    return workflow
  if (typeof source !== "function")
    return source.cfg.workflow
  return resolveWorkflow([["default", WORKFLOW_DEFAULTS], ["user", readUserWorkflow()]])
}

const stageResult = (name: StageName, failed: boolean): Update => ({ stage_status: { [name]: failed ? "failed" : "done" } })

function producerOf(deps: Deps, state: State, attempt: number): string | null {
  if (attempt > 1)
    return deps.agentNames?.fixer ?? null
  return state.baseline !== undefined && state.baseline !== null ? deps.agentNames?.coder ?? null : null
}

/** 作业分支上的阶段提交；越界 / git 出错转成 break_reason，交给熔断。 */
function stageCommit(deps: Deps, source: "implement" | "gate-fix", round: number, summary: string): Update {
  if (!deps.commit)
    return {}
  try {
    const hash = deps.commit(source, round, summary)
    deps.log(hash ? `[提交] ${source === "implement" ? "编码" : "门禁修复"}第 ${round} 轮：${hash.slice(0, 7)}` : "[提交] 没有改动，跳过")
    return {}
  }
  catch (e) {
    const err = e as Error
    deps.log(`[提交] ${err.message}`)
    const v = (err as { violations?: { path: string }[] }).violations
    if (v)
      deps.metrics?.reject(source === "implement" ? "implement" : "gate", round, "whitelist", source === "implement" ? deps.agentNames?.coder ?? null : deps.agentNames?.fixer ?? null, v.map(x => x.path))
    return { break_reason: `${err.name === "WhitelistError" ? "WHITELIST_VIOLATION" : "COMMIT_ERROR"}: ${err.message}` }
  }
}

type MainGraph = StateGraph<typeof PipelineState.spec, State, Update, string>

/** 阶段按工作流配置拼；entry="verify" 只有门禁，直接对当前工作区跑门禁闭环。 */
export function buildMainGraph(source: Source, entry: Entry = "code", opts: MainGraphOptions = {}) {
  const plan = stagePlan(workflowFor(source, opts.workflow), entry)
  const codegraph = buildCodeGraph(source)
  const reviewgraph = buildReviewGraph(source)

  // 节点随配置增减（LangGraph 不允许不可达的节点），所以不用链式写法
  const g = new StateGraph(PipelineState) as unknown as MainGraph
  for (const stage of plan) {
    if (stage.name === "implement") {
      g.addNode(N.CODE, async (state: State, config: LangGraphRunnableConfig) => {
        const out: Update = pick(await codegraph.invoke(state, config), CODE_KEYS)
        if (!out.break_reason)
          Object.assign(out, stageCommit(resolveDeps(source, state), "implement", 1, state.requirement ?? ""))
        return { ...out, ...stageResult("implement", Boolean(out.break_reason)) }
      })
    }
    else if (stage.name === "gate") {
      addGate(g, source, reviewgraph)
    }
    else { // 尚未实现：记一笔就过
      g.addNode(stage.node, async (state: State) => {
        resolveDeps(source, state).log(`[${stage.node}] 尚未实现，跳过`)
        return { stage_status: { [stage.name]: "skipped" } }
      })
    }
  }
  addEnds(g, source)

  const next = (i: number): string => (i + 1 < plan.length ? plan[i + 1].node : N.DELIVER)
  g.addEdge(START, plan[0].node) // 门禁不能关（validateWorkflow），plan 不会是空的
  plan.forEach((stage, i) => {
    const after = next(i)
    if (stage.name === "gate") {
      g.addConditionalEdges(N.VERIFY, (s: State) => {
        const route = routeAfterVerify(s, resolveDeps(source, s).cfg.maxRetries)
        return route === N.DELIVER ? after : route
      }, [after, N.REVIEW, N.BREAKER])
      g.addConditionalEdges(N.REVIEW, (s: State) => (s.break_reason ? N.BREAKER : N.VERIFY), [N.VERIFY, N.BREAKER])
    }
    else {
      g.addConditionalEdges(stage.node, (s: State) => (s.break_reason ? N.BREAKER : after), [after, N.BREAKER])
    }
  })
  g.addEdge(N.DELIVER, END)
  g.addEdge(N.BREAKER, END)
  return g.compile({ checkpointer: opts.checkpointer, name: entry === "code" ? N.PIPELINE_NAME : N.FIX_LOOP_NAME })
}

function addGate(g: MainGraph, source: Source, reviewgraph: ReturnType<typeof buildReviewGraph>): void {
  g.addNode(N.VERIFY, async (state: State) => {
      const deps = resolveDeps(source, state)
      const { cfg, log, gate } = deps
      log("[门禁] 运行 verify…")
      const r = await gate()
      const attempt = (state.attempt ?? 0) + (r.passed ? 0 : 1)
      const codes = [...new Set(r.failures.map(f => f.code ?? "?"))].sort()
      log(`[门禁] 退出码 ${r.exitCode}` + (codes.length ? `，失败项 ${codes.join(",")}（第 ${attempt}/${cfg.maxRetries + 1} 次失败）` : "，通过"))
      const out: Update = {
        verify_exit: r.exitCode,
        failures: r.failures,
        attempt,
        plan: null,
        history: [{ attempt, exit: r.exitCode, codes }],
      }
      if (r.exitCode === 2)
        out.break_reason = "GATE_CONFIG_ERROR"
      else if (!r.passed && attempt > cfg.maxRetries)
        out.break_reason = `RETRY_LIMIT: ${cfg.maxRetries} fix round(s) exhausted`
      if (r.passed || out.break_reason)
        Object.assign(out, stageResult("gate", Boolean(out.break_reason)))
      if (!r.passed) // 被门禁打回的是上一轮的产出：第一轮是写代码的，之后是修复的（修复回环第一轮是现有工作区）
        deps.metrics?.reject("gate", attempt, "gate", producerOf(deps, state, attempt), codes)
      return out
    })
  g.addNode(N.REVIEW, async (state: State, config: LangGraphRunnableConfig) => {
    const out: Update = pick(await reviewgraph.invoke(state, config), REVIEW_KEYS)
    if (!out.break_reason) {
      const codes = [...new Set((state.failures ?? []).map(f => f.code ?? "?"))].sort().join("、")
      Object.assign(out, stageCommit(resolveDeps(source, state), "gate-fix", state.attempt ?? 1, `修复 ${codes || "门禁失败项"}`))
    }
    return out.break_reason ? { ...out, ...stageResult("gate", true) } : out
  })
}

function addEnds(g: MainGraph, source: Source): void {
  g.addNode(N.DELIVER, async (state: State) => {
      const { cfg, log } = resolveDeps(source, state)
      // 流水线自己的产物目录（.agent/）不算改动
      const own = relative(cfg.projectRoot, cfg.stateDir).replaceAll("\\", "/")
      const ownPrefix = own && !own.startsWith("..") ? own + "/" : null
      const files = [...new Set(changedHunks(cfg.projectRoot, state.baseline, [], 1e12).map(h => h.file))]
        .filter(f => !(ownPrefix && f.startsWith(ownPrefix))).sort()
      const rounds = state.attempt ?? 0
      writeText(`${cfg.stateDir}/delivery.json`, JSON.stringify({
        requirement: state.requirement,
        fix_rounds: rounds,
        changed_files: files,
        history: state.history ?? [],
        stages: state.stage_status ?? {},
        delivered_at: new Date().toISOString(),
      }, null, 2))
      // 有编码前快照（pipeline）时是“本次改动”；fix_loop 没有快照，只能说工作区里有多少未提交改动
      const changed = state.baseline ? `本次改动 ${files.length} 个文件` : `工作区有 ${files.length} 个未提交的改动文件`
      const summary = `已交付：门禁通过，${changed}` + (rounds ? `，经过 ${rounds} 轮自动修复` : "") + "。代码未提交，等待人工签字发布。"
      log(`[交付] ${summary}`)
      return { status: "delivered" as const, summary, changed_files: files }
    })
  g.addNode(N.BREAKER, async (state: State) => {
      const deps = resolveDeps(source, state)
      // 设计稿读取失败是人就在跟前的操作问题（如没选中图层），不发邮件
      const result = (state.break_reason ?? "").startsWith("DESIGN_ERROR") ? "skipped(local error)" : await deps.notifier({ ...state })
      const summary = explainBreak(state, result)
      deps.log(`[熔断] ${summary}`)
      return { status: "broken" as const, summary }
    })
}

/** 每个阶段至少一步，门禁每轮 verify + review 两步；留余量，但真正的上限是 attempt 计数。 */
export const recursionLimit = (maxRetries: number): number => 10 + STAGES.length + 3 * (maxRetries + 2)

/** init=null 表示从 threadId 的最后一个检查点继续。 */
async function runThread(deps: Deps, entry: Entry, init: Update | null, threadId: string): Promise<State> {
  const cp = await openCheckpointer(deps.cfg)
  try {
    if (init === null && !cp)
      throw new Error("resume needs checkpoints; set checkpoint.enabled=true in agent.config.json")
    const graph = buildMainGraph(deps, entry, { checkpointer: cp?.saver })
    const config = { recursionLimit: recursionLimit(deps.cfg.maxRetries), configurable: { thread_id: threadId } }
    if (cp) {
      remember(deps.cfg, threadId)
      deps.log(`[运行] 线程 ${threadId}`)
    }
    if (init === null) {
      const snapshot = await graph.getState(config)
      if (!snapshot.values || !Object.keys(snapshot.values).length)
        throw new Error(`no checkpoint for thread ${threadId}`)
      if (!snapshot.next.length) {
        deps.log(`[运行] 线程 ${threadId} 已结束（${(snapshot.values as State).status}）`)
        return snapshot.values as State
      }
    }
    return await graph.invoke(init, config) as State
  }
  finally {
    cp?.close()
  }
}

export async function runPipeline(deps: Deps, requirement: string, designRef?: string | null): Promise<State> {
  return runThread(deps, "code", { requirement, project_root: deps.cfg.projectRoot, design_ref: designRef ?? null, attempt: 0 }, newThreadId("code"))
}

/** 不写新代码，只对当前工作区跑 verify ⇄ review/fix 闭环（人修完后复验也用它）。 */
export async function runFixLoop(deps: Deps): Promise<State> {
  return runThread(deps, "verify", { requirement: "(修复当前工作区)", project_root: deps.cfg.projectRoot, attempt: 0 }, newThreadId("verify"))
}

/** 从检查点继续一次被中断的运行；默认取最近一次。 */
export async function resume(deps: Deps, threadId?: string | null): Promise<State> {
  const id = threadId || lastThread(deps.cfg)
  if (!id)
    throw new Error("no previous run to resume")
  return runThread(deps, entryOf(id), null, id)
}
