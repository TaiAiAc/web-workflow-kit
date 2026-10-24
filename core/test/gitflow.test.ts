// 作业分支、锁、阶段提交、合并预演与落地（真实 git 仓库，门禁用假的）。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  abandonRun, checkResume, discard, type FlowContext, fixGitignore, FlowError, git, hold, installCommandFor, listManifests,
  merge, mergeTargets, NeedsRehearsal, preflight, readManifest, rehearse, slugify, startRun, worktreeDir,
} from "../src/gitflow.ts"
import { WhitelistError } from "../src/whitelist.ts"
import { tempDir } from "./helpers.ts"

const PASS_GATE = async () => ({ exitCode: 0, passed: true, failures: [] })
const FAIL_GATE = async () => ({ exitCode: 1, passed: false, failures: [{ code: "TYPECHECK_FAIL", check: "tsc", message: "x" }] })

/** 干净的仓库：main 上一个提交，.gitignore 已忽略 .agent/ */
function repo(opts: { ignoreAgent?: boolean } = {}): FlowContext {
  const root = tempDir()
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  g("init", "-q", "-b", "main")
  g("config", "user.email", "t@t")
  g("config", "user.name", "t")
  writeFileSync(join(root, ".gitignore"), opts.ignoreAgent === false ? "node_modules/\n" : ".agent/\n")
  writeFileSync(join(root, "app.ts"), "export const a = 1\n")
  g("add", ".")
  g("commit", "-qm", "init")
  return { root, stateDir: join(root, ".agent"), git: { branch_prefix: "wwk/", keep_failed_branches: 3 }, repoDir: "docs/wwk" }
}

const head = (ctx: FlowContext, ref = "HEAD") => git(ctx.root, ["rev-parse", ref])
const branch = (ctx: FlowContext) => git(ctx.root, ["symbolic-ref", "--short", "HEAD"])
const exists = (ctx: FlowContext, b: string) => git(ctx.root, ["branch", "--list", b]) !== ""

/** 开工 → 改一个文件提交 → 交付，返回 manifest */
function delivered(ctx: FlowContext, id = "r1", file = "app.ts", content = "export const a = 2\n") {
  const flow = startRun(ctx, id, "登录页 Login")
  writeFileSync(join(ctx.root, file), content)
  flow.commit("implement", 1, "做登录页")
  return flow.finish(true)
}

describe("开工检查", () => {
  it("不是仓库、没有提交都直接拒绝", () => {
    const ctx = { ...repo(), root: tempDir() }
    assert.equal(preflight(ctx)[0].code, "NOT_GIT")
    execFileSync("git", ["init", "-q"], { cwd: ctx.root })
    assert.equal(preflight(ctx)[0].code, "NO_COMMITS")
  })

  it("问题一次列全：没忽略 .agent/、工作区脏、分离 HEAD", () => {
    const ctx = repo({ ignoreAgent: false })
    writeFileSync(join(ctx.root, "new.ts"), "")
    git(ctx.root, ["checkout", "-q", "--detach"])
    const codes = preflight(ctx).map(p => p.code)
    assert.deepEqual(codes.sort(), ["DETACHED", "DIRTY", "GITIGNORE"])
    assert.throws(() => startRun(ctx, "r1", "x"), FlowError)
  })

  it("一键修复 .gitignore：单独提交在当前分支，别的改动不带进去", () => {
    const ctx = repo({ ignoreAgent: false })
    writeFileSync(join(ctx.root, "app.ts"), "changed\n")
    git(ctx.root, ["add", "app.ts"])
    fixGitignore(ctx)
    assert.equal(git(ctx.root, ["show", "--name-only", "--format=", "HEAD"]), ".gitignore")
    assert.match(readFileSync(join(ctx.root, ".gitignore"), "utf8"), /node_modules\/\n\.agent\/\n$/)
    assert.ok(!preflight(ctx).some(p => p.code === "GITIGNORE"))
  })

  it("工作区干净的判断不看 .agent/", () => {
    const ctx = repo()
    mkdirSync(ctx.stateDir, { recursive: true })
    writeFileSync(join(ctx.stateDir, "x.json"), "{}")
    assert.deepEqual(preflight(ctx), [])
  })

  it("锁：活着的进程占着就拒绝；进程已不在的残留锁清掉", () => {
    const ctx = repo()
    mkdirSync(ctx.stateDir, { recursive: true })
    writeFileSync(join(ctx.stateDir, "lock"), JSON.stringify({ run_id: "other", pid: process.pid, started_at: "t" }))
    assert.ok(preflight(ctx).some(p => p.code === "LOCKED"))
    writeFileSync(join(ctx.stateDir, "lock"), JSON.stringify({ run_id: "other", pid: 2 ** 22 + 12345, started_at: "t" }))
    assert.deepEqual(preflight(ctx), [])
    assert.ok(!existsSync(join(ctx.stateDir, "lock")))
  })

  it("有待合并 / 待处理的运行就不许开新运行", () => {
    const ctx = repo()
    delivered(ctx)
    const p = preflight(ctx)
    assert.equal(p[0].code, "PENDING")
    assert.deepEqual(p[0].detail, ["r1"])
  })

  it("slug：只留 [a-z0-9-]，中文取拼音首字母，最多 24 字符", () => {
    assert.equal(slugify("登录页 Login 设置"), "dly-login-sz")
    assert.equal(slugify("Add   dark-mode toggle!!"), "add-dark-mode-toggle")
    const long = slugify("这是一个非常非常非常非常非常非常长的需求标题啊啊啊")
    assert.equal(long.length, 24)
    assert.ok(long.startsWith("zsygfcfc"))
    assert.equal(slugify("🙂？？"), "")
  })
})

describe("作业分支与阶段提交", () => {
  it("开工拉 wwk/<时间>-<slug>，加锁，写 manifest", () => {
    const ctx = repo()
    const base = head(ctx)
    const flow = startRun(ctx, "r1", "登录页", new Date(2026, 9, 24, 9, 5))
    assert.equal(flow.branch, "wwk/20261024-0905-dly")
    assert.equal(branch(ctx), flow.branch)
    assert.ok(existsSync(join(ctx.stateDir, "lock")))
    const m = readManifest(ctx.stateDir, "r1")!
    assert.deepEqual(m.base, { branch: "main", hash: base })
    assert.equal(m.status, "running")
    assert.equal(m.docs_dir, "docs/wwk/20261024-dly")
    flow.finish(false)
    // 同一分钟同一需求再开：分支名加序号
    assert.equal(startRun(ctx, "r2", "登录页", new Date(2026, 9, 24, 9, 5)).branch, "wwk/20261024-0905-dly-2")
  })

  it("每阶段每轮一次提交，提交信息带阶段、run、轮次；没改动不提交", () => {
    const ctx = repo()
    const flow = startRun(ctx, "r1", "登录页")
    assert.equal(flow.commit("implement", 1, "做登录页"), null)
    writeFileSync(join(ctx.root, "app.ts"), "export const a = 2\n")
    const h = flow.commit("implement", 1, "做登录页")!
    writeFileSync(join(ctx.root, "app.ts"), "export const a = 3\n")
    flow.commit("gate-fix", 2, "修复 TYPECHECK_FAIL")
    assert.equal(git(ctx.root, ["log", "-1", "--format=%s", h]), "wwk(implement): 做登录页 [run r1 round 1]")
    assert.equal(git(ctx.root, ["log", "-1", "--format=%s"]), "wwk(gate): 修复 TYPECHECK_FAIL [run r1 round 2]")
    assert.deepEqual(readManifest(ctx.stateDir, "r1")!.work.commits.map(c => [c.stage, c.round]), [["implement", 1], ["gate", 2]])
  })

  it("越界改动被白名单拦下；结束时残留存成 patch、清掉、切回原分支", () => {
    const ctx = repo()
    const flow = startRun(ctx, "r1", "x")
    writeFileSync(join(ctx.root, "rules.yaml"), "hacked: true\n")
    writeFileSync(join(ctx.root, "app.ts"), "export const a = 9\n")
    assert.throws(() => flow.commit("implement", 1, "x"), WhitelistError)
    const m = flow.finish(false, "越界")
    assert.equal(m.status, "failed")
    assert.match(m.note!, /leftover\.patch/)
    assert.equal(branch(ctx), "main")
    assert.equal(readFileSync(join(ctx.root, "app.ts"), "utf8"), "export const a = 1\n")
    assert.ok(!existsSync(join(ctx.root, "rules.yaml")))
    assert.match(readFileSync(join(ctx.stateDir, "runs", "r1", "leftover.patch"), "utf8"), /hacked: true/)
    assert.ok(!existsSync(join(ctx.stateDir, "lock")))
    assert.ok(exists(ctx, m.work.branch)) // 失败分支保留
  })

  it("交付：待合并，切回原分支，释放锁", () => {
    const ctx = repo()
    const m = delivered(ctx)
    assert.equal(m.status, "ready_to_merge")
    assert.equal(m.verify.gate, true)
    assert.equal(branch(ctx), "main")
    assert.ok(!existsSync(join(ctx.stateDir, "lock")))
  })

  it("失败分支只留最近 3 个", () => {
    const ctx = repo()
    const branches: string[] = []
    for (let i = 1; i <= 5; i++) {
      const flow = startRun(ctx, `r${i}`, `需求 ${i}`, new Date(2026, 9, 24, 9, i))
      branches.push(flow.branch)
      flow.finish(false)
    }
    assert.deepEqual(branches.map(b => exists(ctx, b)), [false, false, true, true, true])
  })

  it("进程半路退出：开工检查拦下（否则新分支会从作业分支拉出），收尾后切回原分支、标失败", () => {
    const ctx = repo()
    const flow = startRun(ctx, "r1", "x")
    writeFileSync(join(ctx.root, "app.ts"), "半截改动\n")
    // 模拟进程崩溃：锁里的进程已经不在，manifest 还停在 running
    writeFileSync(join(ctx.stateDir, "lock"), JSON.stringify({ run_id: "r1", pid: 2 ** 22 + 4321, started_at: "t" }))
    const p = preflight(ctx).find(x => x.code === "INTERRUPTED")
    assert.deepEqual(p?.detail, ["r1"])
    assert.throws(() => startRun(ctx, "r2", "y"), /中途中断/)
    const m = abandonRun(ctx, readManifest(ctx.stateDir, "r1")!)
    assert.equal(m.status, "failed")
    assert.equal(branch(ctx), "main")
    assert.equal(readFileSync(join(ctx.root, "app.ts"), "utf8"), "export const a = 1\n")
    assert.ok(exists(ctx, flow.branch))
    assert.deepEqual(preflight(ctx), [])
    assert.throws(() => abandonRun(ctx, m), /不是中断状态/)
  })

  it("断点恢复：分支或 head 对不上就拒绝", () => {
    const ctx = repo()
    const flow = startRun(ctx, "r1", "x")
    writeFileSync(join(ctx.root, "app.ts"), "2\n")
    flow.commit("implement", 1, "x")
    checkResume(ctx.root, flow.manifest)
    git(ctx.root, ["commit", "-q", "--allow-empty", "-m", "手动提交"])
    assert.throws(() => checkResume(ctx.root, flow.manifest), /分支被改动过/)
    git(ctx.root, ["switch", "-q", "main"])
    assert.throws(() => checkResume(ctx.root, flow.manifest), /当前分支是 main/)
  })
})

describe("合并预演与落地", () => {
  it("合并目标：排除作业分支，显示落后数、冲突预检、是否检出", () => {
    const ctx = repo()
    git(ctx.root, ["branch", "release"])
    const m = delivered(ctx)
    git(ctx.root, ["switch", "-q", "release"])
    writeFileSync(join(ctx.root, "app.ts"), "export const a = 'conflict'\n")
    git(ctx.root, ["commit", "-qam", "release 改了同一行"])
    git(ctx.root, ["switch", "-q", "main"])
    const targets = mergeTargets(ctx, m)
    assert.deepEqual(targets.map(t => t.branch).sort(), ["main", "release"])
    const main = targets.find(t => t.branch === "main")!
    const release = targets.find(t => t.branch === "release")!
    assert.deepEqual([main.behind, main.conflicts, main.checked_out], [0, [], "here"])
    assert.deepEqual([release.behind, release.conflicts, release.checked_out], [1, ["app.ts"], null])
  })

  it("预演通过：S 的父提交是目标 head，目标分支不动，临时目录清掉", async () => {
    const ctx = repo()
    const m = delivered(ctx)
    const before = head(ctx, "main")
    const r = await rehearse(ctx, m, { target: "main", gate: PASS_GATE, installCommand: null })
    assert.equal(r.passed, true)
    assert.equal(git(ctx.root, ["rev-parse", `${r.result_hash}^`]), before)
    assert.equal(head(ctx, "main"), before)
    assert.equal(readManifest(ctx.stateDir, "r1")!.status, "ready_to_merge")
    assert.ok(!existsSync(worktreeDir(ctx.root, "r1")))
    assert.equal(git(ctx.root, ["worktree", "list"]).split("\n").length, 1)
  })

  it("预演门禁失败：不合并、标待处理，目标分支没有被移动", async () => {
    const ctx = repo()
    const m = delivered(ctx)
    const before = head(ctx, "main")
    const r = await rehearse(ctx, m, { target: "main", gate: FAIL_GATE, installCommand: null })
    assert.equal(r.passed, false)
    assert.match(r.reason!, /TYPECHECK_FAIL/)
    assert.equal(head(ctx, "main"), before)
    assert.equal(m.status, "held")
    assert.throws(() => merge(ctx, m, "main"), NeedsRehearsal)
    assert.equal(head(ctx, "main"), before)
    assert.ok(exists(ctx, m.work.branch))
  })

  it("预演遇到冲突、依赖装失败都标待处理", async () => {
    const ctx = repo()
    const m = delivered(ctx)
    writeFileSync(join(ctx.root, "app.ts"), "export const a = 'main 也改了'\n")
    git(ctx.root, ["commit", "-qam", "main 前进"])
    const conflict = await rehearse(ctx, m, { target: "main", gate: PASS_GATE, installCommand: null })
    assert.match(conflict.reason!, /有冲突/)

    const ctx2 = repo()
    const m2 = delivered(ctx2)
    const r = await rehearse(ctx2, m2, { target: "main", gate: PASS_GATE, installCommand: `"${process.execPath}" -e "process.exit(3)"` })
    assert.match(r.reason!, /依赖安装失败（退出码 3）/)
    assert.equal(m2.status, "held")
  })

  it("合并到当前分支（检出在项目目录）：快进到 S，删作业分支，记 manifest", async () => {
    const ctx = repo()
    const m = delivered(ctx)
    const r = await rehearse(ctx, m, { target: "main", gate: PASS_GATE, installCommand: null })
    const done = merge(ctx, m, "main")
    assert.equal(head(ctx, "main"), r.result_hash)
    assert.equal(readFileSync(join(ctx.root, "app.ts"), "utf8"), "export const a = 2\n") // 工作区跟着更新
    assert.ok(!exists(ctx, m.work.branch))
    assert.equal(done.status, "merged")
    assert.deepEqual([done.merge!.target, done.merge!.result_hash, done.merge!.work_branch_deleted], ["main", r.result_hash, true])
    assert.equal(git(ctx.root, ["for-each-ref", "refs/wwk"]), "")
    assert.equal(git(ctx.root, ["log", "--format=%s", "-1", "main"]), "登录页 Login") // squash：一个提交
  })

  it("合并到没检出的分支：update-ref 移动，当前分支和工作区不动", async () => {
    const ctx = repo()
    git(ctx.root, ["branch", "release"])
    const m = delivered(ctx)
    const r = await rehearse(ctx, m, { target: "release", gate: PASS_GATE, installCommand: null })
    merge(ctx, m, "release", "自定义提交说明")
    const after = head(ctx, "release")
    assert.notEqual(after, r.result_hash) // 改了说明：新提交、同一棵树
    assert.equal(git(ctx.root, ["rev-parse", `${after}^{tree}`]), r.result_tree)
    assert.equal(git(ctx.root, ["log", "-1", "--format=%B", after]).trim(), "自定义提交说明")
    assert.equal(branch(ctx), "main")
    assert.equal(readFileSync(join(ctx.root, "app.ts"), "utf8"), "export const a = 1\n")
  })

  it("预演后目标分支又前进了：拒绝落地，要求重新预演", async () => {
    const ctx = repo()
    git(ctx.root, ["branch", "release"])
    const m = delivered(ctx)
    await rehearse(ctx, m, { target: "release", gate: PASS_GATE, installCommand: null })
    git(ctx.root, ["switch", "-q", "release"])
    git(ctx.root, ["commit", "-q", "--allow-empty", "-m", "别人推进了 release"])
    git(ctx.root, ["switch", "-q", "main"])
    const moved = head(ctx, "release")
    assert.throws(() => merge(ctx, m, "release"), /需要重新预演/)
    assert.equal(head(ctx, "release"), moved)
    assert.ok(exists(ctx, m.work.branch))
  })

  it("目标在别的 worktree 检出、或在这里检出但工作区脏：拒绝", async () => {
    const ctx = repo()
    git(ctx.root, ["branch", "release"])
    const m = delivered(ctx)
    await rehearse(ctx, m, { target: "release", gate: PASS_GATE, installCommand: null })
    const other = join(tempDir(), "wt")
    git(ctx.root, ["worktree", "add", "-q", other, "release"])
    assert.throws(() => merge(ctx, m, "release"), /正在 .* 检出/)
    git(ctx.root, ["worktree", "remove", "--force", other])

    await rehearse(ctx, m, { target: "main", gate: PASS_GATE, installCommand: null })
    writeFileSync(join(ctx.root, "scratch.ts"), "")
    assert.throws(() => merge(ctx, m, "main"), /工作区有未提交的改动/)
    assert.ok(exists(ctx, m.work.branch))
  })

  it("落地后 head / tree 对不上：不删作业分支（-D 前唯一的保险）", async () => {
    const ctx = repo()
    git(ctx.root, ["branch", "release"])
    const m = delivered(ctx)
    await rehearse(ctx, m, { target: "release", gate: PASS_GATE, installCommand: null })
    m.verify.on_merged_result!.result_tree = git(ctx.root, ["rev-parse", "main^{tree}"]) // 预期的树与 S 不符
    assert.throws(() => merge(ctx, m, "release"), /合并后校验失败.*保留未删/)
    assert.ok(exists(ctx, m.work.branch))
    assert.equal(readManifest(ctx.stateDir, "r1")!.status, "ready_to_merge")
  })

  it("不合并 → 待处理；作废 → 失败，分支按保留策略处理", () => {
    const ctx = repo()
    const m = delivered(ctx)
    assert.equal(hold(ctx, m).status, "held")
    assert.equal(discard(ctx, m).status, "failed")
    assert.deepEqual(preflight(ctx), [])
    assert.equal(listManifests(ctx.stateDir)[0].note, "已作废")
  })

  it("装依赖命令按锁文件选", () => {
    const root = tempDir()
    assert.equal(installCommandFor(root), null)
    writeFileSync(join(root, "package.json"), "{}")
    assert.deepEqual(installCommandFor(root), ["npm", "install"])
    writeFileSync(join(root, "package-lock.json"), "{}")
    assert.deepEqual(installCommandFor(root), ["npm", "ci"])
    writeFileSync(join(root, "pnpm-lock.yaml"), "")
    assert.deepEqual(installCommandFor(root), ["pnpm", "install", "--frozen-lockfile"])
  })
})
