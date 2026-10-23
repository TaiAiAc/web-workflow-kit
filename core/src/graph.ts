// 主图（平铺）：codegraph → verify ⇄ reviewgraph → deliver | breaker（与 Python 版 main_graph.py 一致）。
// 放行只看 verify_exit == 0；熔断由 attempt 计数在代码里强制，与模型输出无关。
import { relative } from "node:path"
import type { LangGraphRunnableConfig } from "@langchain/langgraph"
import { END, START, StateGraph } from "@langchain/langgraph"
import { END_TURN, ERROR } from "./agents.ts"
import { writeText } from "./config.ts"
import { codePrompt, type Deps, fixPrompt } from "./deps.ts"
import { changedHunks, snapshot } from "./diffs.ts"
import * as N from "./names.ts"
import { PipelineState, type State, type Update } from "./state.ts"

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
      const { cfg, log, coder } = resolveDeps(source, state)
      const baseline = snapshot(cfg.projectRoot)
      log("[写代码] 编码 agent 工作中…")
      const r = await coder.run(codePrompt(state.requirement, state.spec), cfg.projectRoot)
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
      const { cfg, log, reviewer } = resolveDeps(source, state)
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
      const plan = await reviewer(payload)
      log(`[验收审阅] 结论 ${plan.verdict}（经 ${plan.reviewer ?? "?"}）：${plan.summary ?? ""}`)
      const out: Update = { plan }
      if (plan.verdict === "needs_human")
        out.break_reason = `NEEDS_HUMAN: ${plan.summary ?? ""}`
      return out
    })
    .addNode(N.FIX, async (state) => {
      const { cfg, log, fixer } = resolveDeps(source, state)
      log("[执行修复] 修复 agent 工作中…")
      const r = await fixer.run(fixPrompt(state.attempt ?? 1, cfg.maxRetries, state.failures ?? [], state.plan), cfg.projectRoot)
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
}
const NOTIFY_EXPLAINED: Record<string, string> = { sent: "已发熔断邮件", deduped: "24 小时内已就同类问题发过邮件，本次不重复发送" }

export function explainBreak(state: State, notify: string): string {
  const reason = state.break_reason ?? ""
  const i = reason.indexOf(":")
  const key = i < 0 ? reason : reason.slice(0, i)
  const detail = i < 0 ? "" : reason.slice(i + 1).trim()
  let text = `已熔断：${BREAK_EXPLAINED[key] ?? (reason || "原因未知")}`
  if (detail && ["NEEDS_HUMAN", "DESIGN_ERROR", "SPEC_ERROR"].includes(key))
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

/** entry="verify" 跳过 codegraph，直接对当前工作区跑门禁闭环。 */
export function buildMainGraph(source: Source, entry: "code" | "verify" = "code") {
  const codegraph = buildCodeGraph(source)
  const reviewgraph = buildReviewGraph(source)

  // 节点按入口有无（fix_loop 没有“编码”，LangGraph 不允许不可达的节点），所以不用链式写法
  const g = new StateGraph(PipelineState) as unknown as StateGraph<typeof PipelineState.spec, State, Update, string>
  if (entry === "code")
    g.addNode(N.CODE, async (state: State, config: LangGraphRunnableConfig) => pick(await codegraph.invoke(state, config), CODE_KEYS))
  g.addNode(N.VERIFY, async (state: State) => {
      const { cfg, log, gate } = resolveDeps(source, state)
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
      return out
    })
  g.addNode(N.REVIEW, async (state: State, config: LangGraphRunnableConfig) => pick(await reviewgraph.invoke(state, config), REVIEW_KEYS))
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

  if (entry === "code") {
    g.addEdge(START, N.CODE)
    g.addConditionalEdges(N.CODE, (s: State) => (s.break_reason ? N.BREAKER : N.VERIFY), [N.VERIFY, N.BREAKER])
  }
  else {
    g.addEdge(START, N.VERIFY)
  }
  g.addConditionalEdges(N.VERIFY, (s: State) => routeAfterVerify(s, resolveDeps(source, s).cfg.maxRetries), [N.DELIVER, N.REVIEW, N.BREAKER])
  g.addConditionalEdges(N.REVIEW, (s: State) => (s.break_reason ? N.BREAKER : N.VERIFY), [N.VERIFY, N.BREAKER])
  g.addEdge(N.DELIVER, END)
  g.addEdge(N.BREAKER, END)
  return g.compile({ name: entry === "code" ? N.PIPELINE_NAME : N.FIX_LOOP_NAME })
}

/** 每轮 verify + review 两步；留余量，但真正的上限是 attempt 计数。 */
export const recursionLimit = (maxRetries: number): number => 10 + 3 * (maxRetries + 2)

export async function runPipeline(deps: Deps, requirement: string, designRef?: string | null): Promise<State> {
  const graph = buildMainGraph(deps, "code")
  return graph.invoke({ requirement, project_root: deps.cfg.projectRoot, design_ref: designRef ?? null, attempt: 0 },
    { recursionLimit: recursionLimit(deps.cfg.maxRetries) })
}

/** 不写新代码，只对当前工作区跑 verify ⇄ review/fix 闭环（人修完后复验也用它）。 */
export async function runFixLoop(deps: Deps): Promise<State> {
  const graph = buildMainGraph(deps, "verify")
  return graph.invoke({ requirement: "(修复当前工作区)", project_root: deps.cfg.projectRoot, attempt: 0 },
    { recursionLimit: recursionLimit(deps.cfg.maxRetries) })
}
