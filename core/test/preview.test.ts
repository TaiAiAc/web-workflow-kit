// 预览：把项目跑起来（真实子进程，开发服务器是一段打印地址后挂着的 node 脚本），看状态、拿地址、停止。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { after, describe, it } from "node:test"
import { loadConfig } from "../src/config.ts"
import { getPreview, type Preview, startPreview, stopAllPreviews, stopPreview } from "../src/console/preview.ts"
import { git, startRun, worktreeDir } from "../src/gitflow.ts"
import { tempDir } from "./helpers.ts"

after(stopAllPreviews)

// 假开发服务器：打印一行本机地址后一直挂着；FAIL 时什么都不打印就退出
const SERVER = (port: number) => `console.log("  ➜  Local:   http://localhost:${port}/"); setInterval(() => {}, 1000)`
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "demo", private: true, scripts })
// 代码写进文件再用 node 跑：Windows 上 npm 用 cmd 执行脚本，`node -e "...\"..."` 这种转义 cmd 不认
function nodeCmd(code: string): string {
  const file = join(tempDir(), "server.mjs")
  writeFileSync(file, code)
  return `"${process.execPath}" "${file}"`
}

function repo(files: Record<string, string>) {
  const root = tempDir()
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" })
  g("init", "-q", "-b", "main")
  g("config", "user.email", "t@t")
  g("config", "user.name", "t")
  g("config", "core.autocrlf", "false")
  writeFileSync(join(root, ".gitignore"), ".agent/\n")
  for (const [f, t] of Object.entries(files))
    writeFileSync(join(root, f), t)
  g("add", ".")
  g("commit", "-qm", "init")
  return root
}

async function until(project: string, ok: (p: Preview) => boolean, ms = 20000): Promise<Preview> {
  const end = Date.now() + ms
  for (;;) {
    const p = getPreview(project)!
    if (ok(p))
      return p
    if (Date.now() > end)
      throw new Error(`预览没到预期状态：${JSON.stringify({ status: p.status, error: p.error, log: p.log.slice(-5) })}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

describe("预览", () => {
  it("项目目录里跑 package.json 的 dev 脚本：拿到地址就是运行中，停止后进程结束", async () => {
    const root = repo({ "package.json": pkg({ dev: nodeCmd(SERVER(5301)) }) })
    const cfg = loadConfig(root)
    const first = startPreview(cfg, null)
    assert.ok(["preparing", "starting"].includes(first.status)) // 不用装依赖时同步就走到了启动
    const p = await until(root, x => x.status === "running")
    assert.equal(p.url, "http://localhost:5301/")
    assert.equal(p.via, "package.json 脚本")
    assert.match(p.command!, /^npm run dev$/)
    assert.equal(p.source, "项目目录")
    assert.ok(!existsSync(join(root, "package-lock.json"))) // 没声明依赖就不装，不在项目里生成锁文件
    assert.equal(stopPreview(root)!.status, "stopped")
    await until(root, x => x.exitCode !== null || x.status === "stopped")
  })

  it("待合并的运行：在项目外的临时目录检出作业分支来跑，停止后临时目录清掉", async () => {
    const root = repo({ "package.json": pkg({ dev: nodeCmd(SERVER(5302)) }) })
    const cfg = loadConfig(root)
    const ctx = { root, stateDir: cfg.stateDir, git: { branch_prefix: "wwk/", keep_failed_branches: 3 }, repoDir: "docs/wwk" }
    const flow = startRun(ctx, "r1", "改端口")
    writeFileSync(join(root, "package.json"), pkg({ dev: nodeCmd(SERVER(5303)) })) // 作业分支上的版本
    flow.commit("implement", 1, "改端口")
    flow.finish(true)
    startPreview(cfg, "r1")
    const running = await until(root, x => x.status === "running", 30000)
    assert.equal(running.url, "http://localhost:5303/") // 跑的是作业分支，不是项目目录里的 main
    assert.match(running.source, /^作业分支 wwk\//)
    assert.ok(existsSync(worktreeDir(root, "preview-r1")))
    stopPreview(root)
    await until(root, () => !existsSync(worktreeDir(root, "preview-r1")))
    assert.equal(git(root, ["worktree", "list"]).split("\n").length, 1)
  })

  it("没有脚本就问 agent；agent 也给不出命令就报失败并说明", async () => {
    const root = repo({ "README.md": "x" })
    const cfg = loadConfig(root)
    startPreview(cfg, null, { ask: async () => nodeCmd(SERVER(5304)) })
    const p = await until(root, x => x.status === "running")
    assert.deepEqual([p.via, p.url], ["agent 判断", "http://localhost:5304/"])
    stopPreview(root)

    startPreview(cfg, null, { ask: async () => null })
    const f = await until(root, x => x.status === "failed")
    assert.match(f.error!, /找不到启动方式/)
  })

  it("停止时连同另起进程组的服务一起结束（像 pnpm 跑脚本那样），不留孤儿进程", { skip: process.platform === "win32" }, async () => {
    // 外层进程把真正的服务放进新的进程组（detached），服务打印自己的 pid 和地址
    const inner = `console.log("pid=" + process.pid); console.log("Local: http://localhost:5306/"); setInterval(() => {}, 1000)`
    const outer = `import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", ${JSON.stringify(inner)}], { detached: true, stdio: "inherit" }); setInterval(() => {}, 1000)`
    const root = repo({ "package.json": pkg({ dev: nodeCmd(outer) }) })
    startPreview(loadConfig(root), null)
    const p = await until(root, x => x.status === "running")
    const pid = Number(p.log.find(l => l.startsWith("pid="))!.slice(4))
    const alive = (n: number) => {
      try {
        process.kill(n, 0)
        return true
      }
      catch {
        return false
      }
    }
    assert.ok(alive(pid))
    stopPreview(root)
    const end = Date.now() + 5000
    while (alive(pid) && Date.now() < end)
      await new Promise(r => setTimeout(r, 100))
    assert.ok(!alive(pid), `服务进程 ${pid} 还活着`)
  })

  it("配置里的 preview.command 优先；进程没打印地址就退出算启动失败", async () => {
    const root = repo({ "package.json": pkg({ dev: nodeCmd(SERVER(5305)) }) })
    const cfg = loadConfig(root)
    cfg.raw.preview = { command: nodeCmd("process.exit(3)") }
    startPreview(cfg, null)
    const f = await until(root, x => x.status === "failed")
    assert.equal(f.via, "agent.config.json 的 preview.command")
    assert.equal(f.exitCode, 3)
    assert.match(f.error!, /没有打印出访问地址/)
  })
})
