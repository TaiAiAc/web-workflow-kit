// 控制台里的作业分支：开工 / 收尾接在完整流水线的运行上，合并弹窗的接口（目标列表、预演、合并、不合并、作废）在这里。
// 预演要装依赖、跑门禁，耗时长，放后台跑；页面轮询 /api/flow 看进度。
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { Config } from "../config.ts"
import { runGate } from "../gate.ts"
import * as F from "../gitflow.ts"
import * as W from "./workspaces.ts"

type Json = Record<string, any>

export function flowContext(cfg: Config): F.FlowContext {
  const wf = cfg.workflow.raw
  return { root: cfg.projectRoot, stateDir: cfg.stateDir, git: wf.git, repoDir: wf.documents.repo_dir }
}

/** 在临时 worktree 上跑门禁：规则用原项目的（rules.yaml 不一定入库），产物写进 worktree 自己的 .agent/。 */
function worktreeGate(cfg: Config, log: (line: string) => void) {
  const vcfg = cfg.get("verify")
  const own = join(cfg.projectRoot, "rules.yaml")
  const rules = vcfg.rules ? resolve(cfg.projectRoot, vcfg.rules) : existsSync(own) ? own : null
  return (wt: string) => runGate(new Config({ ...cfg.raw, verify: { ...vcfg, rules } }, wt, join(wt, ".agent"), cfg.env, cfg.envSources), { log })
}

/** 默认合并目标：这个工作区上次选的（分支还在的话），否则是开工时的分支。 */
export function defaultTarget(cfg: Config, m: F.Manifest, targets?: F.MergeTarget[]): string {
  const last = W.find(cfg.projectRoot)?.lastMergeTarget
  const list = targets ?? F.mergeTargets(flowContext(cfg), m)
  return last && list.some(t => t.branch === last) ? last : m.base.branch
}

export function rehearseRun(cfg: Config, m: F.Manifest, target: string, log: (line: string) => void, message?: string): Promise<F.Rehearsal> {
  const gateCfg = cfg.workflow.raw.stages.gate ?? {}
  return F.rehearse(flowContext(cfg), m, {
    target,
    message,
    log,
    gate: worktreeGate(cfg, log),
    installCommand: gateCfg.install_command === undefined ? "auto" : gateCfg.install_command,
    env: cfg.childEnv(),
    timeoutMs: Number(cfg.get("verify").timeout_sec ?? 3600) * 1000,
  })
}

// ---------------- 后台预演 ----------------

interface Job {
  target: string
  log: string[]
  started: number
}

const jobs = new Map<string, Job>()
const jobKey = (root: string, runId: string): string => `${W.normalize(root)}#${runId}`

export function rehearsing(root: string, runId: string): Job | undefined {
  return jobs.get(jobKey(root, runId))
}

/** 后台开始预演；同一次运行已经在预演就报错。 */
export function startRehearsal(cfg: Config, m: F.Manifest, target: string, message?: string): void {
  const key = jobKey(cfg.projectRoot, m.run_id)
  if (jobs.has(key))
    throw new Error("这次运行正在预演，请等它结束")
  const job: Job = { target, log: [], started: Date.now() / 1000 }
  jobs.set(key, job)
  const log = (line: string) => {
    job.log.push(line)
    if (job.log.length > 400)
      job.log.splice(0, job.log.length - 400)
  }
  void rehearseRun(cfg, m, target, log, message)
    .catch(e => log(`[合并预演] 出错：${(e as Error).message}`))
    .finally(() => jobs.delete(key))
}

// ---------------- 弹窗数据 ----------------

/** 合并弹窗要的一切：manifest、可选目标、默认目标、建议提交说明、是否在预演。 */
export function describeFlow(cfg: Config, runId: string): Json {
  const m = F.readManifest(cfg.stateDir, runId)
  if (!m)
    throw new Error(`运行 ${runId} 没有作业分支记录`)
  const job = rehearsing(cfg.projectRoot, runId)
  const pending = m.status === "ready_to_merge" || m.status === "held"
  let targets: F.MergeTarget[] = []
  let error: string | null = null
  if (pending) {
    try {
      targets = F.mergeTargets(flowContext(cfg), m)
    }
    catch (e) { // 作业分支被手动删了之类：照样把 manifest 给页面
      error = (e as Error).message
    }
  }
  return {
    manifest: m,
    targets,
    default_target: pending && !error ? defaultTarget(cfg, m, targets) : null,
    suggested_message: F.suggestedMessage(m),
    rehearsing: job ? { target: job.target, started: job.started, log: job.log.slice(-60) } : null,
    error,
  }
}

/** 运行列表里显示的作业分支摘要 */
export function flowBrief(stateDir: string, runId: string): Json | null {
  const m = F.readManifest(stateDir, runId)
  if (!m)
    return null
  const r = m.verify.on_merged_result
  return {
    status: m.status,
    branch: m.work.branch,
    base: m.base.branch,
    note: m.note,
    rehearsal: r ? { target: r.target, passed: r.passed } : null,
    merged_into: m.merge?.target ?? null,
  }
}

export function mergeRun(cfg: Config, runId: string, target: string, message?: string): F.Manifest {
  const m = F.readManifest(cfg.stateDir, runId)
  if (!m)
    throw new Error(`运行 ${runId} 没有作业分支记录`)
  if (rehearsing(cfg.projectRoot, runId))
    throw new Error("这次运行正在预演，请等它结束")
  const done = F.merge(flowContext(cfg), m, target, message)
  W.setLastMergeTarget(cfg.projectRoot, target)
  return done
}

export function abandonRun(cfg: Config, runId: string): F.Manifest {
  const m = F.readManifest(cfg.stateDir, runId)
  if (!m)
    throw new Error(`运行 ${runId} 没有作业分支记录`)
  return F.abandonRun(flowContext(cfg), m)
}

export function holdRun(cfg: Config, runId: string, action: "hold" | "discard"): F.Manifest {
  const m = F.readManifest(cfg.stateDir, runId)
  if (!m)
    throw new Error(`运行 ${runId} 没有作业分支记录`)
  if (rehearsing(cfg.projectRoot, runId))
    throw new Error("这次运行正在预演，请等它结束")
  return action === "hold" ? F.hold(flowContext(cfg), m) : F.discard(flowContext(cfg), m)
}
