// 作业分支与合并（第二阶段）：开工拉作业分支，每阶段每轮一次提交，结束后在项目外的临时 worktree 里预演合并结果并跑门禁，
// 人只在合并弹窗点一次。工具永不 push。
// - 状态机：running → ready_to_merge | failed；ready_to_merge → merged | held | failed（作废）；held → merged | failed；
// - 运行结束（无论成败）都切回原分支、释放锁；待合并 / 待处理只记在 manifest（.agent/runs/<id>/manifest.json）里；
// - 目标分支只在预演门禁通过、用户确认后移动一次，且要求它还停在预演时的起点（CAS），中途崩溃不会留下坏状态。
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import process from "node:process"
import { pinyin } from "pinyin-pro"
import { userHome, writeJsonAtomic, writeText } from "./config.ts"
import type { Failure } from "./gate.ts"
import { run, which } from "./proc.ts"
import { assertCommitAllowed, type CommitSource, type ReturnStage } from "./whitelist.ts"

export type FlowStatus = "running" | "ready_to_merge" | "merged" | "failed" | "held"

export interface StageCommit {
  stage: string
  round: number
  hash: string
  message: string
}

export interface Rehearsal {
  target: string
  /** 预演起点：当时的目标分支 head（落地时的 CAS 依据） */
  target_head_before: string
  result_hash: string | null
  result_tree: string | null
  message: string
  passed: boolean
  reason: string | null
  failures: Failure[]
  at: string
}

export interface Manifest {
  run_id: string
  status: FlowStatus
  requirement: string
  started_at: string
  finished_at: string | null
  base: { branch: string, hash: string }
  work: { branch: string, head: string, commits: StageCommit[] }
  /** 本次运行的入库文档目录（相对项目根目录） */
  docs_dir: string
  verify: { gate: boolean | null, ac: boolean | null, on_merged_result: Rehearsal | null }
  merge: {
    target: string
    target_head_before: string
    method: "squash"
    result_hash: string
    result_tree: string
    gate_after_merge: boolean
    work_branch_deleted: boolean
    at: string
  } | null
  /** 失败 / 待处理的原因，给人看 */
  note: string | null
}

export interface FlowContext {
  root: string
  stateDir: string
  /** 工作流配置的 git / documents 段 */
  git: { branch_prefix: string, keep_failed_branches: number }
  repoDir: string
}

// ---------------- git ----------------

export class GitError extends Error {}

/** 同步跑 git；失败抛 GitError（带 stderr）。 */
export function git(root: string, args: string[], opts: { input?: string, allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", input: opts.input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim()
  }
  catch (e) {
    if (opts.allowFail)
      return ""
    const err = e as { stderr?: string, message: string }
    throw new GitError(`git ${args.join(" ")} 失败：${(err.stderr || err.message).trim().slice(0, 500)}`)
  }
}

const gitOk = (root: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" })
    return true
  }
  catch {
    return false
  }
}

const currentBranch = (root: string): string | null => git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true }) || null
const revParse = (root: string, rev: string): string => git(root, ["rev-parse", "--verify", `${rev}^{commit}`])
const treeOf = (root: string, rev: string): string => git(root, ["rev-parse", `${rev}^{tree}`])

/** 本机没配 user.name / user.email 时用一个固定身份，免得提交直接失败。 */
function identity(root: string): string[] {
  return git(root, ["config", "user.email"], { allowFail: true }) ? [] : ["-c", "user.name=web-workflow-kit", "-c", "user.email=wwk@localhost"]
}

const stateRel = (ctx: FlowContext): string => relative(ctx.root, ctx.stateDir).replaceAll("\\", "/") || ".agent"

/** 未提交的改动（不含 .agent/），用于「工作区必须干净」。 */
export function dirtyFiles(root: string, stateDir: string): string[] {
  const own = `${relative(root, stateDir).replaceAll("\\", "/")}/`
  return git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]).split("\0").filter(Boolean)
    .map(l => l.slice(3)).filter(p => p && !p.startsWith(own))
}

// ---------------- manifest ----------------

export const manifestPath = (stateDir: string, runId: string): string => join(stateDir, "runs", runId, "manifest.json")

export function readManifest(stateDir: string, runId: string): Manifest | null {
  if (!/^[a-z0-9-]+$/i.test(runId))
    return null
  try {
    return JSON.parse(readFileSync(manifestPath(stateDir, runId), "utf8"))
  }
  catch {
    return null
  }
}

export function writeManifest(stateDir: string, m: Manifest): void {
  writeJsonAtomic(manifestPath(stateDir, m.run_id), m)
}

export function listManifests(stateDir: string): Manifest[] {
  let ids: string[]
  try {
    ids = readdirSync(join(stateDir, "runs"))
  }
  catch {
    return []
  }
  return ids.map(id => readManifest(stateDir, id)).filter((m): m is Manifest => Boolean(m))
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
}

/** 中途中断的运行：manifest 还是 running，但没有活着的进程持锁（进程崩了 / 被杀了）。 */
export function interruptedRuns(stateDir: string): Manifest[] {
  const lock = heldLock(stateDir)
  return listManifests(stateDir).filter(m => m.status === "running" && lock?.run_id !== m.run_id)
}

/** 还没处理完的运行（待合并 / 待处理）：有它在就不许开新运行。 */
export const pendingRuns = (stateDir: string): Manifest[] => listManifests(stateDir).filter(m => m.status === "ready_to_merge" || m.status === "held")

// ---------------- 锁 ----------------

interface LockInfo {
  run_id: string
  pid: number
  started_at: string
}

const lockFile = (stateDir: string): string => join(stateDir, "lock")

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM" // 进程在，只是不归我们管
  }
}

/** 锁被活着的进程占着时返回锁信息；残留的锁（进程已不在）顺手清掉。 */
export function heldLock(stateDir: string): LockInfo | null {
  let info: LockInfo
  try {
    info = JSON.parse(readFileSync(lockFile(stateDir), "utf8"))
  }
  catch {
    return null
  }
  if (Number.isInteger(info.pid) && alive(info.pid))
    return info
  rmSync(lockFile(stateDir), { force: true })
  return null
}

export function acquireLock(stateDir: string, runId: string): void {
  const held = heldLock(stateDir)
  if (held && held.run_id !== runId)
    throw new FlowError([{ code: "LOCKED", message: `运行 ${held.run_id} 正在占用这个工作区（进程 ${held.pid}，开始于 ${held.started_at}）` }])
  writeJsonAtomic(lockFile(stateDir), { run_id: runId, pid: process.pid, started_at: new Date().toISOString() })
}

export function releaseLock(stateDir: string, runId: string): void {
  const held = heldLock(stateDir)
  if (!held || held.run_id === runId)
    rmSync(lockFile(stateDir), { force: true })
}

// ---------------- 开工 ----------------

export interface Problem {
  code: "NOT_GIT" | "NO_COMMITS" | "DETACHED" | "GITIGNORE" | "DIRTY" | "PENDING" | "LOCKED" | "INTERRUPTED"
  message: string
  /** DIRTY：未提交的文件；PENDING：待处理的运行 id */
  detail?: string[]
}

export class FlowError extends Error {
  readonly problems: Problem[]
  constructor(problems: Problem[]) {
    super(problems.map(p => p.message).join("；"))
    this.name = "FlowError"
    this.problems = problems
  }
}

/** 开工前检查，问题一次列全；不改任何东西。 */
export function preflight(ctx: FlowContext): Problem[] {
  if (!gitOk(ctx.root, ["rev-parse", "--is-inside-work-tree"]))
    return [{ code: "NOT_GIT", message: "项目不是 git 仓库：作业分支需要 git" }]
  if (!gitOk(ctx.root, ["rev-parse", "--verify", "HEAD"]))
    return [{ code: "NO_COMMITS", message: "仓库还没有任何提交：先提交一次再开工" }]
  const problems: Problem[] = []
  const interrupted = interruptedRuns(ctx.stateDir)
  if (interrupted.length) // 不处理的话新作业分支会从上一个作业分支拉出来
    problems.push({ code: "INTERRUPTED", message: `运行 ${interrupted.map(m => m.run_id).join("、")} 中途中断（进程退出），仓库可能还停在作业分支上：先收尾`, detail: interrupted.map(m => m.run_id) })
  if (!currentBranch(ctx.root))
    problems.push({ code: "DETACHED", message: "当前处于分离 HEAD：先切到一个分支，作业分支从当前分支拉出" })
  const rel = stateRel(ctx)
  if (!gitOk(ctx.root, ["check-ignore", "-q", `${rel}/lock`]))
    problems.push({ code: "GITIGNORE", message: `.gitignore 没有忽略 ${rel}/：运行产物会混进提交` })
  const dirty = dirtyFiles(ctx.root, ctx.stateDir)
  if (dirty.length)
    problems.push({ code: "DIRTY", message: `工作区有 ${dirty.length} 个未提交的改动：先提交或丢弃（不会替你 stash）`, detail: dirty.slice(0, 20) })
  const pending = pendingRuns(ctx.stateDir)
  if (pending.length)
    problems.push({ code: "PENDING", message: `运行 ${pending.map(m => m.run_id).join("、")} 还在等你处理（合并 / 不合并 / 作废），处理后才能开新运行`, detail: pending.map(m => m.run_id) })
  const lock = heldLock(ctx.stateDir)
  if (lock)
    problems.push({ code: "LOCKED", message: `运行 ${lock.run_id} 正在占用这个工作区` })
  return problems
}

/** 一次性修复：把运行产物目录追加进 .gitignore，单独提交在当前分支上。 */
export function fixGitignore(ctx: FlowContext): string {
  const rel = stateRel(ctx)
  const file = join(ctx.root, ".gitignore")
  const text = existsSync(file) ? readFileSync(file, "utf8") : ""
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${rel}/\n`)
  git(ctx.root, [...identity(ctx.root), "commit", "-m", `chore: 忽略 ${rel}/（web-workflow-kit 运行产物）`, "--", ".gitignore"])
  return revParse(ctx.root, "HEAD")
}

/** 需求标题 → 分支名用的 slug：只留 [a-z0-9-]，中文取拼音首字母，最多 24 个字符。 */
export function slugify(title: string): string {
  const firstLine = title.split(/\r?\n/)[0] ?? ""
  const raw = pinyin(firstLine, { pattern: "first", toneType: "none", type: "array", nonZh: "consecutive" }).join("")
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "")
}

const stamp = (d: Date, sep = "-"): string => {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${sep}${p(d.getHours())}${p(d.getMinutes())}`
}

/** 开工：检查、加锁、从当前分支拉作业分支、写 manifest。 */
export function startRun(ctx: FlowContext, runId: string, requirement: string, now = new Date()): Flow {
  git(ctx.root, ["worktree", "prune"], { allowFail: true })
  const problems = preflight(ctx)
  if (problems.length)
    throw new FlowError(problems)
  acquireLock(ctx.stateDir, runId)
  try {
    const base = { branch: currentBranch(ctx.root)!, hash: revParse(ctx.root, "HEAD") }
    const slug = slugify(requirement) || `run${runId}`
    let branch = `${ctx.git.branch_prefix}${stamp(now)}-${slug}`
    for (let i = 2; gitOk(ctx.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); i++)
      branch = `${ctx.git.branch_prefix}${stamp(now)}-${slug}-${i}`
    git(ctx.root, ["switch", "-q", "-c", branch])
    const m: Manifest = {
      run_id: runId,
      status: "running",
      requirement,
      started_at: now.toISOString(),
      finished_at: null,
      base,
      work: { branch, head: base.hash, commits: [] },
      docs_dir: `${ctx.repoDir.replace(/\/+$/, "")}/${stamp(now, "").slice(0, 8)}-${slug}`,
      verify: { gate: null, ac: null, on_merged_result: null },
      merge: null,
      note: null,
    }
    writeManifest(ctx.stateDir, m)
    return new Flow(ctx, m)
  }
  catch (e) {
    releaseLock(ctx.stateDir, runId)
    throw e
  }
}

// ---------------- 运行中 ----------------

export class Flow {
  readonly ctx: FlowContext
  manifest: Manifest

  constructor(ctx: FlowContext, manifest: Manifest) {
    this.ctx = ctx
    this.manifest = manifest
  }

  get branch(): string {
    return this.manifest.work.branch
  }

  /**
   * 阶段提交：暂存全部改动 → 按白名单把关（越界抛 WhitelistError，运行中止）→ 提交。
   * 没有改动时不提交，返回 null。
   */
  commit(source: CommitSource, round: number, summary: string, returnStage?: ReturnStage): string | null {
    const { root } = this.ctx
    git(root, ["add", "-A"])
    if (gitOk(root, ["diff", "--cached", "--quiet"]))
      return null
    assertCommitAllowed(root, source, { repoDir: this.ctx.repoDir, returnStage })
    const stage = source === "gate-fix" ? "gate" : source === "acceptance-redo" ? (returnStage ?? "acceptance") : source
    const title = summary.split(/\r?\n/)[0].trim().slice(0, 60) || "阶段产出"
    const message = `wwk(${stage}): ${title} [run ${this.manifest.run_id} round ${round}]`
    git(root, [...identity(root), "commit", "-q", "--no-verify", "-m", message])
    const hash = revParse(root, "HEAD")
    this.manifest.work.head = hash
    this.manifest.work.commits.push({ stage, round, hash, message })
    writeManifest(this.ctx.stateDir, this.manifest)
    return hash
  }

  /**
   * 运行结束：没提交的残留存成 patch 再清掉（开工时工作区是干净的，残留只可能来自本次运行），
   * 切回原分支，释放锁；交付了就待合并，否则失败并按保留策略清理旧的失败分支。
   */
  finish(delivered: boolean, note: string | null = null): Manifest {
    const { root, stateDir } = this.ctx
    const m = this.manifest
    try {
      if (dirtyFiles(root, stateDir).length) {
        git(root, ["add", "-A"])
        const patch = git(root, ["diff", "--cached", "--binary"])
        writeText(join(stateDir, "runs", m.run_id, "leftover.patch"), `${patch}\n`)
        git(root, ["reset", "-q", "--hard", "HEAD"])
        git(root, ["clean", "-fdq"]) // 不带 -x：被忽略的文件（含 .agent/）不动
        note = [note, `有未提交的残留，已存到 .agent/runs/${m.run_id}/leftover.patch 后清掉`].filter(Boolean).join("；")
      }
      if (currentBranch(root) === m.work.branch)
        git(root, ["switch", "-q", m.base.branch])
    }
    finally {
      m.status = delivered ? "ready_to_merge" : "failed"
      m.verify.gate = delivered
      m.finished_at = new Date().toISOString()
      m.note = note
      writeManifest(stateDir, m)
      releaseLock(stateDir, m.run_id)
    }
    if (!delivered)
      pruneFailedBranches(this.ctx)
    return m
  }
}

/** 中断收尾：和正常失败一样存残留、切回原分支、标失败；作业分支按保留策略处理。 */
export function abandonRun(ctx: FlowContext, m: Manifest): Manifest {
  if (!interruptedRuns(ctx.stateDir).some(x => x.run_id === m.run_id))
    throw new FlowError([{ code: "LOCKED", message: `运行 ${m.run_id} 不是中断状态（${m.status}），不用收尾` }])
  return new Flow(ctx, m).finish(false, "运行中途中断（进程退出），已收尾")
}

/** 失败的作业分支只留最近 keep_failed_branches 个；待处理的不动。 */
export function pruneFailedBranches(ctx: FlowContext): string[] {
  const keep = ctx.git.keep_failed_branches
  const failed = listManifests(ctx.stateDir).filter(m => m.status === "failed" && m.work.branch)
  const deleted: string[] = []
  for (const m of failed.slice(keep)) {
    if (gitOk(ctx.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${m.work.branch}`]) && currentBranch(ctx.root) !== m.work.branch) {
      git(ctx.root, ["branch", "-q", "-D", m.work.branch])
      deleted.push(m.work.branch)
    }
  }
  return deleted
}

/** 断点恢复前：当前分支必须是作业分支、head 必须是最后一次阶段提交；不一致就拒绝，不自动修正。 */
export function checkResume(root: string, m: Manifest): void {
  const branch = currentBranch(root)
  if (branch !== m.work.branch)
    throw new FlowError([{ code: "DETACHED", message: `不能恢复：当前分支是 ${branch ?? "分离 HEAD"}，运行 ${m.run_id} 的作业分支是 ${m.work.branch}` }])
  const head = revParse(root, "HEAD")
  if (head !== m.work.head)
    throw new FlowError([{ code: "DIRTY", message: `不能恢复：${m.work.branch} 的 head 是 ${head.slice(0, 7)}，最后一次阶段提交是 ${m.work.head.slice(0, 7)}（分支被改动过）` }])
}

// ---------------- 合并目标 ----------------

export interface MergeTarget {
  branch: string
  head: string
  /** 目标分支上、作业分支没有的提交数（目标已前进多少） */
  behind: number
  upstream: string | null
  /** 相对上游：本地领先 / 落后 */
  upstream_ahead: number | null
  upstream_behind: number | null
  conflicts: string[]
  checked_out: "here" | "elsewhere" | null
}

/** 本地分支（排除作业分支）及其状态；conflicts 用 git merge-tree 预检，不碰工作区。 */
export function mergeTargets(ctx: FlowContext, m: Manifest): MergeTarget[] {
  const { root } = ctx
  const workHead = revParse(root, m.work.branch)
  const checked = checkedOut(root)
  const lines = git(root, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(upstream:short)", "refs/heads"]).split("\n").filter(Boolean)
  return lines.map((line) => {
    const [branch, head, upstream] = line.split("\0")
    return { branch, head, upstream: upstream || null }
  }).filter(b => !b.branch.startsWith(ctx.git.branch_prefix)).map((b) => {
    const behind = Number(git(root, ["rev-list", "--count", `${workHead}..${b.head}`]))
    let ua: number | null = null
    let ub: number | null = null
    if (b.upstream) {
      const counts = git(root, ["rev-list", "--left-right", "--count", `${b.branch}...${b.upstream}`], { allowFail: true }).split(/\s+/)
      if (counts.length === 2) {
        ua = Number(counts[0])
        ub = Number(counts[1])
      }
    }
    const loc = checked.get(b.branch)
    return {
      ...b,
      behind,
      upstream_ahead: ua,
      upstream_behind: ub,
      conflicts: mergeConflicts(root, b.head, workHead),
      checked_out: loc === undefined ? null : sameDir(loc, root) ? "here" : "elsewhere",
    }
  })
}

function mergeConflicts(root: string, target: string, work: string): string[] {
  try {
    execFileSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", target, work], { cwd: root, stdio: "pipe" })
    return []
  }
  catch (e) {
    const out = String((e as { stdout?: Buffer }).stdout ?? "")
    return out.split("\n").slice(1).map(l => l.trim()).filter(Boolean)
  }
}

/** 分支 → 检出它的 worktree 目录 */
function checkedOut(root: string): Map<string, string> {
  const out = new Map<string, string>()
  let dir = ""
  for (const line of git(root, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree "))
      dir = line.slice("worktree ".length)
    else if (line.startsWith("branch refs/heads/"))
      out.set(line.slice("branch refs/heads/".length), dir)
  }
  return out
}

const sameDir = (a: string, b: string): boolean => {
  const norm = (p: string) => {
    try {
      return execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: p, encoding: "utf8" }).trim()
    }
    catch {
      return p
    }
  }
  return norm(a) === norm(b)
}

// ---------------- 合并预演 ----------------

export interface RehearseOptions {
  target: string
  message?: string
  log?: (line: string) => void
  /** 在给定目录（临时 worktree）上跑门禁 */
  gate: (root: string) => Promise<{ exitCode: number, passed: boolean, failures: Failure[] }>
  /** "auto" / 自定义命令 / null（跳过） */
  installCommand?: string | null
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export const suggestedMessage = (m: Manifest): string =>
  `${m.requirement.split(/\r?\n/)[0].trim().slice(0, 72) || "web-workflow-kit 交付"}\n\nweb-workflow-kit run ${m.run_id}，作业分支 ${m.work.branch}（${m.work.commits.length} 次阶段提交）`

export const worktreeDir = (root: string, runId: string): string =>
  join(userHome(), "worktrees", createHash("sha256").update(root.replaceAll("\\", "/")).digest("hex").slice(0, 12), runId)

const rehearsalRef = (runId: string): string => `refs/wwk/rehearsal/${runId}`

/**
 * 预演：在项目外的临时 worktree 里从目标 head 生成 squash 提交 S、装依赖、跑门禁；不动目标分支本身。
 * 通过 → ready_to_merge；冲突 / 装依赖失败 / 门禁失败 → held。无论结果，清理临时 worktree。
 */
export async function rehearse(ctx: FlowContext, m: Manifest, opts: RehearseOptions): Promise<Rehearsal> {
  const { root, stateDir } = ctx
  const log = opts.log ?? (() => {})
  if (m.status !== "ready_to_merge" && m.status !== "held")
    throw new FlowError([{ code: "PENDING", message: `运行 ${m.run_id} 的状态是 ${m.status}，不能预演合并` }])
  acquireLock(stateDir, m.run_id)
  const wt = worktreeDir(root, m.run_id)
  const t0 = revParse(root, `refs/heads/${opts.target}`)
  const message = opts.message ?? suggestedMessage(m)
  const result: Rehearsal = {
    target: opts.target, target_head_before: t0, result_hash: null, result_tree: null, message,
    passed: false, reason: null, failures: [], at: new Date().toISOString(),
  }
  try {
    rmSync(wt, { recursive: true, force: true })
    git(root, ["worktree", "prune"], { allowFail: true })
    mkdirSync(join(wt, ".."), { recursive: true })
    git(root, ["worktree", "add", "-q", "--detach", wt, t0])
    log(`[合并预演] 在临时目录从 ${opts.target}（${t0.slice(0, 7)}）合入 ${m.work.branch}`)
    try {
      git(wt, ["merge", "--squash", "-q", m.work.branch])
    }
    catch (e) {
      result.reason = `与 ${opts.target} 有冲突：${(e as Error).message}`
      return result
    }
    if (gitOk(wt, ["diff", "--cached", "--quiet"])) {
      result.reason = `${m.work.branch} 相对 ${opts.target} 没有任何改动`
      return result
    }
    git(wt, [...identity(root), "commit", "-q", "--no-verify", "-F", "-"], { input: message })
    result.result_hash = revParse(wt, "HEAD")
    result.result_tree = treeOf(wt, "HEAD")
    git(root, ["update-ref", rehearsalRef(m.run_id), result.result_hash]) // 留个引用，临时目录删了 S 也不会被回收

    const install = await installDeps(wt, opts, log)
    if (install) {
      result.reason = install
      return result
    }
    log("[合并预演] 对合并结果跑门禁…")
    const r = await opts.gate(wt)
    result.failures = r.failures
    result.passed = r.passed
    if (!r.passed)
      result.reason = `合并结果的门禁未通过（退出码 ${r.exitCode}）：${[...new Set(r.failures.map(f => f.code))].join("、")}`
    return result
  }
  finally {
    git(root, ["worktree", "remove", "--force", wt], { allowFail: true })
    rmSync(wt, { recursive: true, force: true })
    git(root, ["worktree", "prune"], { allowFail: true })
    m.verify.on_merged_result = result
    m.status = result.passed ? "ready_to_merge" : "held"
    m.note = result.passed ? null : result.reason
    writeManifest(stateDir, m)
    releaseLock(stateDir, m.run_id)
    log(result.passed ? `[合并预演] 通过，可以合并到 ${opts.target}` : `[合并预演] 未通过：${result.reason}`)
  }
}

/** 按锁文件选冻结安装命令；没有 package.json 返回 null（跳过）。 */
export function installCommandFor(root: string): string[] | null {
  if (!existsSync(join(root, "package.json")))
    return null
  if (existsSync(join(root, "pnpm-lock.yaml")))
    return ["pnpm", "install", "--frozen-lockfile"]
  if (existsSync(join(root, "package-lock.json")))
    return ["npm", "ci"]
  if (existsSync(join(root, "yarn.lock")))
    return ["yarn", "install", "--immutable"]
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
    return ["bun", "install", "--frozen-lockfile"]
  return ["npm", "install"]
}

/** 装依赖；失败返回原因，成功或跳过返回 null。 */
async function installDeps(wt: string, opts: RehearseOptions, log: (line: string) => void): Promise<string | null> {
  const setting = opts.installCommand === undefined ? "auto" : opts.installCommand
  if (setting === null)
    return null
  let cmd: string
  let args: string[]
  if (setting === "auto") {
    const auto = installCommandFor(wt)
    if (!auto)
      return null
    const exe = which(auto[0], opts.env)
    if (!exe)
      return `依赖安装失败：找不到 ${auto[0]} 命令`
    ;[cmd, args] = [exe, auto.slice(1)]
  }
  else {
    ;[cmd, args] = process.platform === "win32" ? ["cmd", ["/d", "/s", "/c", setting]] : ["sh", ["-c", setting]]
  }
  log(`[合并预演] 安装依赖：${setting === "auto" ? installCommandFor(wt)!.join(" ") : setting}`)
  const tail: string[] = []
  const r = await run(cmd, args, {
    cwd: wt,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    onLine: (line) => {
      tail.push(line)
      if (tail.length > 20)
        tail.shift()
    },
  })
  if (r.timedOut)
    return "依赖安装失败：超时"
  if (r.code !== 0)
    return `依赖安装失败（退出码 ${r.code}）：\n${tail.join("\n")}`
  return null
}

// ---------------- 合并落地 ----------------

export class NeedsRehearsal extends Error {}

/**
 * 合并：只认通过的预演；目标分支必须还停在预演起点，否则要求重新预演。
 * - 目标检出在项目目录本身：工作区干净时用 merge --ff-only（同样要求 head == 预演起点）；
 * - 检出在别的 worktree：拒绝；
 * - 没检出：update-ref 原子比对并移动。
 * 落地后校验 head == S 且 tree == 预演时的 tree，校验通过才删作业分支。
 */
export function merge(ctx: FlowContext, m: Manifest, target: string, message?: string): Manifest {
  const { root, stateDir } = ctx
  const r = m.verify.on_merged_result
  if (m.status !== "ready_to_merge" || !r || !r.passed || r.target !== target || !r.result_hash || !r.result_tree)
    throw new NeedsRehearsal(`还没有对 ${target} 通过的合并预演`)
  acquireLock(stateDir, m.run_id)
  try {
    const head = revParse(root, `refs/heads/${target}`)
    if (head !== r.target_head_before)
      throw new NeedsRehearsal(`${target} 在预演后又有了新提交（${r.target_head_before.slice(0, 7)} → ${head.slice(0, 7)}），需要重新预演`)

    // 只改了提交说明：树不变、父提交不变，直接用同一棵树生成新提交，不用重跑门禁
    let s = r.result_hash
    const finalMessage = message?.trim() ? message.trim() : r.message
    if (finalMessage !== r.message)
      s = git(root, [...identity(root), "commit-tree", r.result_tree, "-p", r.target_head_before, "-F", "-"], { input: finalMessage })

    const where = checkedOut(root).get(target)
    if (where !== undefined && !sameDir(where, root))
      throw new FlowError([{ code: "LOCKED", message: `${target} 正在 ${where} 检出：请先在那里切走再合并` }])
    if (where !== undefined) {
      const dirty = dirtyFiles(root, stateDir)
      if (dirty.length)
        throw new FlowError([{ code: "DIRTY", message: `${target} 是当前分支，但工作区有未提交的改动：先提交或丢弃再合并`, detail: dirty.slice(0, 20) }])
      git(root, ["merge", "-q", "--ff-only", s])
    }
    else {
      git(root, ["update-ref", "-m", `wwk: merge run ${m.run_id}`, `refs/heads/${target}`, s, r.target_head_before])
    }

    // -D 前唯一的保险：squash 后作业分支不是目标的祖先，只能比 head 和 tree
    const after = revParse(root, `refs/heads/${target}`)
    if (after !== s || treeOf(root, after) !== r.result_tree)
      throw new GitError(`合并后校验失败：${target} 的 head 是 ${after.slice(0, 7)}，预期 ${s.slice(0, 7)}；作业分支 ${m.work.branch} 保留未删`)

    if (currentBranch(root) === m.work.branch)
      git(root, ["switch", "-q", m.base.branch])
    git(root, ["branch", "-q", "-D", m.work.branch])
    git(root, ["update-ref", "-d", rehearsalRef(m.run_id)], { allowFail: true })
    m.status = "merged"
    m.note = null
    m.merge = {
      target,
      target_head_before: r.target_head_before,
      method: "squash",
      result_hash: s,
      result_tree: r.result_tree,
      gate_after_merge: true,
      work_branch_deleted: true,
      at: new Date().toISOString(),
    }
    writeManifest(stateDir, m)
    return m
  }
  finally {
    releaseLock(stateDir, m.run_id)
  }
}

/** 「不合并」：保留作业分支，标待处理。 */
export function hold(ctx: FlowContext, m: Manifest): Manifest {
  if (m.status !== "ready_to_merge" && m.status !== "held")
    throw new FlowError([{ code: "PENDING", message: `运行 ${m.run_id} 的状态是 ${m.status}，不能标待处理` }])
  m.status = "held"
  m.note ??= "选择了不合并"
  writeManifest(ctx.stateDir, m)
  return m
}

/** 「作废」：转为失败，作业分支按失败分支的保留策略处理。 */
export function discard(ctx: FlowContext, m: Manifest): Manifest {
  if (m.status !== "ready_to_merge" && m.status !== "held")
    throw new FlowError([{ code: "PENDING", message: `运行 ${m.run_id} 的状态是 ${m.status}，不能作废` }])
  m.status = "failed"
  m.note = "已作废"
  writeManifest(ctx.stateDir, m)
  git(ctx.root, ["update-ref", "-d", rehearsalRef(m.run_id)], { allowFail: true })
  pruneFailedBranches(ctx)
  return m
}
