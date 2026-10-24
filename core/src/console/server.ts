// 本地控制台服务（页面是 assets/ui/index.html，浏览器版与桌面端共用）。
//
// 纯本地：只监听 127.0.0.1；页面是随包分发的单个 HTML，不加载任何外部资源。
// 图在本进程里运行，节点进度和日志写进运行记录，页面轮询读取；运行结束时记录落盘到项目的 .agent/runs/。
//
// 安全：门禁会执行 rules.yaml 里的命令，所以不能让别的网站借浏览器触发运行——
//   - 只接受 Host 为 127.0.0.1 / localhost 的请求（防 DNS rebinding）；
//   - 每次启动生成随机令牌，只嵌在本页面里，所有 /api 请求必须带 X-WWK-Token；
//   - 只接受 application/json 的 POST（跨站页面能发的“简单请求”会被拒绝）；禁止被其他页面嵌入；
//   - 打开目录、移除、设置 agent 只作用于已加入工作空间的目录。
import { randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname, extname, join } from "node:path"
import { ASSET_EXTS } from "../docs.ts"
import { visionPreflight } from "../vision.ts"
import { agentAvailability, codingAgentChoices, defaultFixChoice } from "../agents.ts"
import { ASSETS_DIR, type Config, DEFAULTS, initProject, loadConfig, writeSnapshot } from "../config.ts"
import { defaultDeps } from "../deps.ts"
import { type Flow, FlowError, fixGitignore, NeedsRehearsal, pendingRuns, preflight, readManifest, startRun } from "../gitflow.ts"
import { buildMainGraph } from "../graph.ts"
import { Metrics, metricsFile, summarize } from "../metrics.ts"
import { stagePlan } from "../workflow.ts"
import * as N from "../names.ts"
import { availability as reviewAvailability, BACKENDS } from "../review.ts"
import type { State } from "../state.ts"
import { openFolder, pickFile, pickFolder, pickImages } from "./pickers.ts"
import * as FL from "./flow.ts"
import { agentStatuses, describeSettings, launchLogin, openTerminal, saveSettings, testDeepseek, testNetwork } from "./settings.ts"
import * as W from "./workspaces.ts"

export const PAGE = join(ASSETS_DIR, "ui", "index.html")
const MAX_RUNS = 50
const MAX_EVENTS = 5000
const RESULT_KEYS = ["status", "summary", "break_reason", "verify_exit", "attempt", "failures", "history",
  "code_stop_reason", "fix_stop_reason", "changed_files"] as const

/** 工具栏「跑门禁」：只跑一次 verify，不审阅不修复。 */
export const GATE_ONLY = "仅门禁"
const GRAPHS: Record<string, "code" | "verify"> = { [N.PIPELINE_NAME]: "code", [N.FIX_LOOP_NAME]: "verify" }

type Json = Record<string, any>

export function inspectFolder(path: string): Json {
  if (!path || !existsSync(path) || !statSync(path).isDirectory())
    return { exists: false }
  let name: string | null = null
  try {
    name = JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name ?? null
  }
  catch {}
  return {
    exists: true,
    package_json: existsSync(join(path, "package.json")),
    name,
    rules_yaml: existsSync(join(path, "rules.yaml")),
    agent_config: existsSync(join(path, "agent.config.json")),
    git: existsSync(join(path, ".git")),
  }
}

/** 编程 / 修复 agent、审阅方式的选项与本机可用性。每次请求现查。 */
export function describeAgents(): Json {
  const cfg = loadConfig(undefined)
  const env = cfg.childEnv()
  const via: Record<string, string> = { claude_cli: "Claude Code CLI", acp: "ACP 协议", dsh_cli: "命令行" }
  const agents = Object.entries(codingAgentChoices(cfg)).map(([key, p]) => {
    const [available, detail] = agentAvailability(p, env)
    return { key, label: p.label ?? key, available, detail, via: via[p.backend] ?? p.backend }
  })
  return {
    default: DEFAULTS.code?.agent ?? "claude",
    agents,
    fix_default: defaultFixChoice(cfg),
    review_default: DEFAULTS.review?.backend ?? "auto",
    reviewers: reviewAvailability(cfg),
  }
}

/** 编程 / 修复 agent、审阅方式只接受已知取值（运行输入和工作空间偏好共用）。 */
export function checkChoices(values: Json): void {
  const agents = DEFAULTS.coding_agents ?? {}
  for (const [field, what] of [["coding_agent", "编程"], ["fix_agent", "修复"]]) {
    if (values[field] && !(values[field] in agents))
      throw new Error(`未知的${what} agent：${values[field]}`)
  }
  if (values.review_backend && !(values.review_backend in BACKENDS))
    throw new Error(`未知的审阅方式：${values.review_backend}`)
}

class Run {
  readonly id = randomBytes(6).toString("hex")
  readonly graph: string
  readonly input: Json
  status: "running" | "done" | "error" = "running"
  readonly events: Json[] = []
  result: Json = {}
  error = ""
  readonly started = Date.now() / 1000
  finished: number | null = null
  /** 作业分支（完整流水线才有）：记下运行产物目录，brief 里读 manifest 用 */
  private stateDir: string | null = null
  /** 开工检查没过时的问题，页面据此给「一键修复」 */
  preflight: Json[] | null = null

  constructor(graph: string, input: Json) {
    this.graph = graph
    this.input = input
  }

  get projectRoot(): string {
    return String(this.input.project_root ?? "")
  }

  emit(event: Json): void {
    if (this.events.length < MAX_EVENTS)
      this.events.push({ t: Math.round((Date.now() / 1000 - this.started) * 100) / 100, ...event })
  }

  log = (line: string): void => this.emit({ type: "log", text: String(line) })

  brief(): Json {
    return {
      id: this.id, graph: this.graph, status: this.status, project_root: this.projectRoot,
      requirement: this.input.requirement ?? "", coding_agent: this.input.coding_agent ?? "",
      review_backend: this.input.review_backend ?? "", fix_agent: this.input.fix_agent ?? "",
      summary: this.result.summary ?? this.error, result_status: this.result.status ?? null,
      started: this.started, finished: this.finished,
      flow: this.stateDir ? FL.flowBrief(this.stateDir, this.id) : null,
    }
  }

  record(): Json {
    return { ...this.brief(), input: this.input, result: this.result, error: this.error, preflight: this.preflight, events: [...this.events] }
  }

  async execute(): Promise<void> {
    let flow: Flow | null = null
    let metrics: Metrics | undefined
    const source = (state: Partial<State>) => defaultDeps(loadConfig(state.project_root || this.projectRoot), {
      log: this.log,
      codingAgent: state.coding_agent || this.input.coding_agent,
      reviewBackend: state.review_backend || this.input.review_backend,
      fixAgent: state.fix_agent || this.input.fix_agent,
      commit: flow ? (src, round, summary) => flow!.commit(src, round, summary) : undefined,
      metrics,
    })
    try {
      const cfg = loadConfig(this.projectRoot)
      writeSnapshot(cfg, this.id) // 本次运行的生效配置（已脱敏）
      metrics = new Metrics(metricsFile(cfg.stateDir, this.id))
      // 完整流水线在作业分支上跑；修复回环、仅门禁是对当前工作区的操作，不拉分支
      if (this.graph === N.PIPELINE_NAME) {
        flow = startRun(FL.flowContext(cfg), this.id, String(this.input.requirement ?? ""))
        this.stateDir = cfg.stateDir
        this.log(`[作业分支] 从 ${flow.manifest.base.branch} 拉出 ${flow.branch}`)
      }
      if (this.graph === GATE_ONLY) {
        this.result = await this.gateOnly(source({ project_root: this.projectRoot }).gate)
        this.status = "done"
        return
      }
      const graph = buildMainGraph(source as never, GRAPHS[this.graph], { workflow: cfg.workflow })
      // 本次要走的步骤（按生效配置），页面据此画还没开始的步骤
      const steps = stagePlan(cfg.workflow, GRAPHS[this.graph]).map(p => (p.name === "implement" ? N.WRITE_CODE : p.node))
      this.emit({ type: "plan", nodes: [...steps, N.DELIVER, ...(flow ? [N.REHEARSE] : [])] })
      let final: Json = {}
      // subgraphs：编码、审阅修复里的子节点（Spec / 写代码 / 审阅 / 修复）也上报，页面按阶段展示
      const input = { ...this.input, ...(flow ? { docs_dir: flow.manifest.docs_dir } : {}) } // 文档放进作业分支对应的目录
      const stream = await graph.stream(input as never, { streamMode: ["tasks", "values"], subgraphs: true, recursionLimit: 200 })
      for await (const [ns, mode, chunk] of stream as AsyncIterable<[string[], string, Json]>) {
        const parent = ns.length ? ns[0].split(":")[0] : null
        if (mode === "values") {
          if (!ns.length)
            final = chunk
        }
        else if ("input" in chunk) { // 任务开始
          this.emit({ type: "node_start", node: chunk.name, parent })
        }
        else { // 任务结束
          this.emit({ type: "node_end", node: chunk.name, parent, error: chunk.error ? String(chunk.error) : null })
        }
      }
      this.result = JSON.parse(JSON.stringify(Object.fromEntries(RESULT_KEYS.filter(k => final[k] !== undefined).map(k => [k, final[k]]))))
      if (flow)
        await this.finishFlow(flow, cfg, final.status === "delivered", final.summary ?? null)
      this.status = "done"
    }
    catch (e) { // 图本身抛错：记下来，页面上显示
      if (e instanceof FlowError)
        this.preflight = e.problems
      this.error = e instanceof FlowError ? e.message : `${(e as Error).name}: ${(e as Error).message}`
      this.log(String((e as Error).stack ?? e).split("\n").slice(0, 4).join("\n"))
      this.status = "error"
      if (flow?.manifest.status === "running") {
        try {
          flow.finish(false, this.error)
          this.log(`[作业分支] 已切回 ${flow.manifest.base.branch}，${flow.branch} 保留`)
        }
        catch (err) {
          this.log(`[作业分支] 收尾失败：${(err as Error).message}`)
        }
      }
    }
    finally {
      this.finished = Date.now() / 1000
      this.emit({ type: "end", status: this.status })
      W.saveRun(this.projectRoot, this.record())
    }
  }

  /** 收尾：切回原分支；交付了就按默认目标先跑一次合并预演，结果在合并弹窗里看。 */
  private async finishFlow(flow: Flow, cfg: Config, delivered: boolean, summary: string | null): Promise<void> {
    const m = flow.finish(delivered, delivered ? null : summary)
    this.log(`[作业分支] 已切回 ${m.base.branch}` + (delivered ? "" : `，${m.work.branch} 保留`))
    if (!delivered)
      return
    this.emit({ type: "node_start", node: N.REHEARSE, parent: null })
    let error: string | null = null
    try {
      const r = await FL.rehearseRun(cfg, m, FL.defaultTarget(cfg, m), this.log)
      if (!r.passed)
        error = r.reason
    }
    catch (e) {
      error = (e as Error).message
      this.log(`[合并预演] 出错：${error}`)
    }
    this.emit({ type: "node_end", node: N.REHEARSE, parent: null, error })
  }

  private async gateOnly(gate: () => Promise<{ exitCode: number, passed: boolean, failures: Json[] }>): Promise<Json> {
    this.emit({ type: "node_start", node: N.VERIFY, parent: null })
    const r = await gate()
    const status = r.passed ? "passed" : r.exitCode === 2 ? "config_error" : "failed"
    const codes = [...new Set(r.failures.map(f => f.code ?? ""))].sort().join("、")
    const summary = { passed: "门禁通过。", failed: `门禁未通过：${codes}。`, config_error: `门禁规则或运行环境有误：${codes}。` }[status]
    this.log(`[门禁] ${summary}`)
    this.emit({ type: "node_end", node: N.VERIFY, parent: null, error: null })
    return { status, verify_exit: r.exitCode, failures: r.failures, summary }
  }
}

/** 三种输入（纯文字 / 图片 + 文字 / MasterGo）二选一地带素材；图片模式要求 codex 可用（B 模式开工预检） */
function checkInputs(cfg: Config, payload: Json): void {
  const images: unknown = payload.images
  if (images === undefined)
    return
  if (!Array.isArray(images) || !images.every(p => typeof p === "string"))
    throw new Error("images 必须是图片路径数组")
  if (images.length && payload.design_ref)
    throw new Error("一次只能带一种素材：图片和设计稿二选一")
  for (const p of images) {
    if (!existsSync(p) || !statSync(p).isFile())
      throw new Error(`图片不存在：${p}`)
    if (!ASSET_EXTS.includes(extname(p).toLowerCase()))
      throw new Error(`只支持图片（${ASSET_EXTS.join(" ")}）：${p}`)
  }
  if (images.length) {
    const [ok, why] = visionPreflight(cfg)
    if (!ok)
      throw new Error(`图片输入需要 Codex：${why}`)
  }
}

export class RunStore {
  readonly runs = new Map<string, Run>()

  start(graph: string, payload: Json): Run {
    const root = String(payload.project_root ?? "").trim()
    if (!root)
      throw new Error("请填写项目路径")
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new Error(`项目路径不存在或不是目录：${root}`)
    const key = W.normalize(root)
    if ([...this.runs.values()].some(r => r.status === "running" && W.normalize(r.projectRoot) === key))
      throw new Error("该项目已有一次运行在进行中，请等它结束（两次运行同时改同一个仓库会互相覆盖）")
    if (graph === N.PIPELINE_NAME) { // 开工检查不过就别建运行，直接告诉页面哪里要处理
      const cfg = loadConfig(root)
      checkInputs(cfg, payload)
      const problems = preflight(FL.flowContext(cfg))
      if (problems.length)
        throw new FlowError(problems)
    }
    const run = new Run(graph, { ...payload, project_root: root })
    this.runs.set(run.id, run)
    for (const [id, r] of [...this.runs].slice(0, -MAX_RUNS)) {
      if (r.status !== "running")
        this.runs.delete(id)
    }
    void run.execute()
    return run
  }

  /** 某个项目的运行记录：内存里的（含进行中）+ 项目里落盘的，按开始时间倒序。 */
  forProject(project: string): Json[] {
    const key = W.normalize(project)
    const live = [...this.runs.values()].filter(r => W.normalize(r.projectRoot) === key).map(r => r.brief())
    const ids = new Set(live.map(r => r.id))
    const stateDir = dirname(W.runsDir(key))
    const saved = W.savedRuns(key).filter(r => !ids.has(r.id)).map((r): Json => ({ ...r, flow: FL.flowBrief(stateDir, r.id) }))
    return [...live, ...saved].sort((a, b) => (b.started ?? 0) - (a.started ?? 0))
  }
}

export function describeWorkspace(ws: W.Workspace, store: RunStore): Json {
  const runs = store.forProject(ws.path)
  const inspect = inspectFolder(ws.path)
  const pending = inspect.exists ? pendingRuns(dirname(W.runsDir(ws.path))).map(m => m.run_id) : []
  return { ...ws, inspect, branch: W.gitBranch(ws.path), last_run: runs[0] ?? null, pending_runs: pending }
}

export interface ConsoleOptions {
  port?: number
  host?: string
  picker?: (initial?: string | null) => Promise<string | null>
  filePicker?: (initial?: string | null) => Promise<string | null>
  imagesPicker?: (initial?: string | null) => Promise<string[]>
  opener?: (path: string) => void
  /** 在系统终端里执行一行命令（设置页的「登录」）；测试里替换掉 */
  terminal?: (line: string) => void
}

export interface ConsoleServer {
  server: Server
  token: string
  store: RunStore
  url: string
  close: () => Promise<void>
}

const POST_ROUTES = new Set(["/api/runs", "/api/pick-folder", "/api/pick-file", "/api/pick-images", "/api/init", "/api/open",
  "/api/workspaces/add", "/api/workspaces/remove", "/api/workspaces/prefs",
  "/api/settings", "/api/settings/test", "/api/auth/login", "/api/workspaces/fix-gitignore",
  "/api/flow/rehearse", "/api/flow/merge", "/api/flow/hold", "/api/flow/discard"])

/** 设置页按项目读写时，只认已加入的工作空间。 */
function workspaceOrNull(project: unknown): string | null {
  const p = String(project ?? "").trim()
  if (!p)
    return null
  const ws = W.find(p)
  if (!ws)
    throw new HttpError(400, `不是已添加的工作空间：${p}`)
  return ws.path
}

class HttpError extends Error {
  readonly status: number
  readonly extra: Json
  constructor(status: number, message: string, extra: Json = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/** 作业分支接口只认已加入的工作空间，按它的配置找 manifest。 */
function flowConfig(project: unknown): Config {
  const p = workspaceOrNull(project)
  if (!p)
    throw new HttpError(400, "请指定工作空间")
  return loadConfig(p)
}

export async function startConsole(opts: ConsoleOptions = {}): Promise<ConsoleServer> {
  const token = randomBytes(24).toString("base64url")
  const store = new RunStore()
  const picker = opts.picker ?? pickFolder
  const filePicker = opts.filePicker ?? pickFile
  const imagesPicker = opts.imagesPicker ?? pickImages
  const opener = opts.opener ?? openFolder
  const terminal = opts.terminal ?? openTerminal
  let allowedHosts = new Set<string>()
  const page = () => readFileSync(PAGE, "utf8").replace("__WWK_TOKEN__", token)

  const send = (res: ServerResponse, status: number, body: string, type: string) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    })
    res.end(body)
  }
  const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8")

  const tokenOk = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers["x-wwk-token"] ?? ""))
    const want = Buffer.from(token)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  const readBody = (req: IncomingMessage) => new Promise<Json>((resolve, reject) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (c: string) => {
      raw += c
      if (raw.length > 1_000_000)
        reject(new HttpError(413, "请求体太大"))
    })
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      }
      catch {
        reject(new HttpError(400, "请求体不是合法的 JSON"))
      }
    })
    req.on("error", reject)
  })

  async function get(url: URL): Promise<unknown> {
    const parts = url.pathname.split("/").filter(Boolean)
    const project = url.searchParams.get("project") ?? ""
    if (url.pathname === "/api/agents")
      return describeAgents()
    if (url.pathname === "/api/inspect")
      return inspectFolder(url.searchParams.get("path") ?? "")
    if (url.pathname === "/api/workspaces")
      return W.load().map(w => describeWorkspace(w, store))
    if (url.pathname === "/api/settings")
      return describeSettings(workspaceOrNull(project))
    if (url.pathname === "/api/auth")
      return agentStatuses(workspaceOrNull(project))
    if (url.pathname === "/api/runs")
      return project ? store.forProject(project) : [...store.runs.values()].sort((a, b) => b.started - a.started).map(r => r.brief())
    if (url.pathname === "/api/metrics") // 按 agent 汇总最近的运行：调用、耗时、token、被打回的次数和原因
      return summarize(flowConfig(project).stateDir, { runs: Number(url.searchParams.get("runs") ?? 50) || 50 })
    if (url.pathname === "/api/flow") {
      const cfg = flowConfig(project)
      try {
        return FL.describeFlow(cfg, url.searchParams.get("run") ?? "")
      }
      catch (e) {
        throw new HttpError(404, (e as Error).message)
      }
    }
    if (parts.length === 3 && parts[0] === "api" && parts[1] === "runs") {
      const run = store.runs.get(parts[2])
      const rec = run ? run.record() : project ? W.loadRun(project, parts[2]) : null
      if (!rec)
        throw new HttpError(404, "运行记录不存在")
      const after = Number(url.searchParams.get("after") ?? 0) || 0
      const events = (rec.events ?? []).slice(after)
      return { ...rec, events, next: after + events.length }
    }
    throw new HttpError(404, "not found")
  }

  async function post(path: string, body: Json): Promise<[number, unknown]> {
    if (path === "/api/settings") {
      const scope = body.scope === "project" ? "project" : "user"
      const proj = workspaceOrNull(body.project)
      if (scope === "project" && !proj)
        throw new HttpError(400, "项目范围的设置需要先选中一个工作空间")
      try {
        saveSettings(scope, proj, body.values ?? {})
      }
      catch (e) {
        throw new HttpError(400, (e as Error).message)
      }
      return [200, describeSettings(proj)]
    }
    if (path === "/api/settings/test") {
      const proj = workspaceOrNull(body.project)
      if (body.kind === "network")
        return [200, await testNetwork(proj)]
      if (body.kind === "deepseek")
        return [200, await testDeepseek(proj)]
      throw new HttpError(400, `未知的检测：${body.kind}`)
    }
    if (path === "/api/auth/login") {
      try {
        return [200, { line: launchLogin(String(body.agent ?? ""), workspaceOrNull(body.project), terminal) }]
      }
      catch (e) {
        throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message)
      }
    }
    if (path.startsWith("/api/flow/")) {
      const cfg = flowConfig(body.project)
      const runId = String(body.run ?? "")
      const message = body.message ? String(body.message) : undefined
      try {
        if (path === "/api/flow/rehearse") {
          const m = readManifest(cfg.stateDir, runId)
          if (!m)
            throw new Error(`运行 ${runId} 没有作业分支记录`)
          FL.startRehearsal(cfg, m, String(body.target ?? ""), message)
          return [202, FL.describeFlow(cfg, runId)]
        }
        if (path === "/api/flow/merge")
          FL.mergeRun(cfg, runId, String(body.target ?? ""), message)
        else
          FL.holdRun(cfg, runId, path === "/api/flow/hold" ? "hold" : "discard")
        return [200, FL.describeFlow(cfg, runId)]
      }
      catch (e) {
        throw new HttpError(e instanceof NeedsRehearsal ? 409 : 400, (e as Error).message, e instanceof FlowError ? { problems: e.problems } : {})
      }
    }
    if (path === "/api/workspaces/add")
      return [200, describeWorkspace(W.add(String(body.path ?? "").trim()), store)]
    if (path.startsWith("/api/workspaces/") || path === "/api/open") {
      const target = String(body.path ?? "").trim()
      const ws = target ? W.find(target) : undefined
      if (!ws) // 删除 / 设置 / 打开目录都只针对已添加的工作空间
        throw new HttpError(400, `不是已添加的工作空间：${target}`)
      if (path === "/api/workspaces/remove") {
        W.remove(target)
        return [200, { removed: ws.path }]
      }
      if (path === "/api/workspaces/fix-gitignore") { // 一次性初始化：把 .agent/ 加进 .gitignore，单独提交在当前分支
        try {
          return [200, { commit: fixGitignore(FL.flowContext(loadConfig(ws.path))), workspace: describeWorkspace(ws, store) }]
        }
        catch (e) {
          throw new HttpError(400, (e as Error).message)
        }
      }
      if (path === "/api/workspaces/prefs") {
        const prefs = body.prefs ?? {}
        checkChoices(prefs)
        return [200, describeWorkspace(W.setPrefs(target, prefs), store)]
      }
      opener(ws.path)
      return [200, { opened: ws.path }]
    }
    if (path === "/api/init") { // 等同 wwk init：复制默认配置，已存在的不覆盖
      const raw = String(body.path ?? "").trim()
      if (!raw)
        throw new HttpError(400, "请填写项目路径")
      if (!existsSync(raw) || !statSync(raw).isDirectory())
        throw new HttpError(400, `项目路径不存在或不是目录：${raw}`)
      const files = initProject(raw)
      const name = (f: string) => f.split(/[\\/]/).pop()
      return [200, { created: files.filter(([, c]) => c).map(([f]) => name(f)), skipped: files.filter(([, c]) => !c).map(([f]) => name(f)), inspect: inspectFolder(raw) }]
    }
    if (path === "/api/pick-images") {
      try {
        return [200, { paths: await imagesPicker(body.initial) }]
      }
      catch (e) {
        throw new HttpError(501, (e as Error).message)
      }
    }
    if (path === "/api/pick-folder" || path === "/api/pick-file") {
      let picked: string | null
      try {
        picked = await (path === "/api/pick-folder" ? picker : filePicker)(body.initial)
      }
      catch (e) {
        throw new HttpError(501, (e as Error).message)
      }
      return [200, { path: picked, inspect: picked ? inspectFolder(picked) : null }]
    }
    // /api/runs
    const graph = body.graph
    if (!(graph in GRAPHS) && graph !== GATE_ONLY)
      throw new HttpError(400, `未知的图：${graph}`)
    const payload = Object.fromEntries(Object.entries(body.input ?? {}).filter(([, v]) => v !== null && v !== ""))
    try {
      checkChoices(payload)
      return [201, { id: store.start(graph, payload).id }]
    }
    catch (e) {
      throw new HttpError(400, (e as Error).message, e instanceof FlowError ? { problems: e.problems } : {})
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (!allowedHosts.has(String(req.headers.host)))
        return json(res, 403, { error: "只接受本机访问" })
      const api = url.pathname.startsWith("/api/")
      if (!api) {
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
          return send(res, 200, page(), "text/html; charset=utf-8")
        return json(res, 404, { error: "not found" })
      }
      if (!tokenOk(req))
        return json(res, 403, { error: "令牌无效，请刷新页面" })
      if (req.method === "GET")
        return json(res, 200, await get(url))
      if (req.method !== "POST" || !POST_ROUTES.has(url.pathname))
        return json(res, 404, { error: "not found" })
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
        return json(res, 415, { error: "需要 application/json" })
      const [status, data] = await post(url.pathname, await readBody(req))
      return json(res, status, data)
    }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 400
      return json(res, status, { error: (e as Error).message, ...(e instanceof HttpError ? e.extra : {}) })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 8765, opts.host ?? "127.0.0.1", () => resolve())
  })
  const port = (server.address() as AddressInfo).port // port=0 时由系统分配，Host 校验要用实际端口
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  return {
    server, token, store,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise(r => server.close(() => r())),
  }
}
