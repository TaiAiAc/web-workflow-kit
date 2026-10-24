// 本地控制台（TS 版）：起一个真实的本地 HTTP 服务，按页面的方式调用。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import process from "node:process"
import { after, before, describe, it } from "node:test"
import { type ConsoleServer, GATE_ONLY, startConsole, stepAgents } from "../src/console/server.ts"
import { loadConfig } from "../src/config.ts"
import * as W from "../src/console/workspaces.ts"
import * as N from "../src/names.ts"
import { DOC_STAGES, tempDir } from "./helpers.ts"

/** 门禁只有一项 typecheck，命令是一段 node 脚本。 */
const rulesRunning = (code: string) =>
  `project_type: web\nprofiles:\n  web:\n    checks: [typecheck]\n    typecheck:\n      run: ${JSON.stringify(`"${process.execPath}" -e "${code}"`)}\n`

/** 干净的 git 仓库：.agent/ 和 .env 已忽略，写好的文件都提交掉 */
function gitRepo(files: Record<string, string>, ignore = ".agent/\n.env\n"): string {
  const root = tempDir()
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim()
  g("init", "-q", "-b", "main")
  g("config", "user.email", "t@t")
  g("config", "user.name", "t")
  writeFileSync(join(root, ".gitignore"), ignore)
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text)
  g("add", ".")
  g("commit", "-qm", "init")
  return root
}
const gitOut = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim()

let c: ConsoleServer
const opened: string[] = []
const terminal: string[] = []
let pick: string | null = null

before(async () => {
  c = await startConsole({ port: 0, picker: async () => pick, filePicker: async () => "/tmp/design.json", imagesPicker: async () => ["/tmp/a.png", "/tmp/b.jpg"], opener: p => opened.push(p), terminal: l => terminal.push(l) })
})
after(() => c.close())

async function request(method: string, path: string, body?: unknown, opts: { token?: boolean, type?: string } = {}) {
  const port = new URL(c.url).port
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(opts.token === false ? {} : { "X-WWK-Token": c.token }),
      "Content-Type": opts.type ?? "application/json",
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  }
  catch {}
  return { status: res.status, body: data, headers: res.headers }
}

async function waitRun(id: string, project?: string) {
  const q = project ? `?project=${encodeURIComponent(project)}` : ""
  for (let i = 0; i < 300; i++) {
    const { body } = await request("GET", `/api/runs/${id}${q}`)
    if (body.status !== "running")
      return body
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error("run did not finish")
}

describe("控制台服务", () => {
  it("页面只在本机提供，并带上令牌", async () => {
    const { status, body, headers } = await request("GET", "/", undefined, { token: false })
    assert.equal(status, 200)
    assert.ok(body.includes(c.token))
    assert.equal(body.includes("__WWK_TOKEN__"), false)
    assert.ok(body.includes("前端交付流水线"))
    assert.equal(headers.get("x-frame-options"), "DENY")
  })

  it("接口要令牌、只接受本机 Host、POST 必须是 JSON", async () => {
    assert.equal((await request("GET", "/api/agents", undefined, { token: false })).status, 403)
    // fetch 不允许改 Host，用 node:http 模拟 DNS rebinding：Host 是别的域名
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: new URL(c.url).port, path: "/api/agents", headers: { "Host": "evil.example", "X-WWK-Token": c.token } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on("error", reject)
      req.end()
    })
    assert.equal(status, 403)
    assert.equal((await request("POST", "/api/runs", "graph=x", { type: "text/plain" })).status, 415)
    assert.equal((await request("POST", "/api/runs", "{bad", {})).status, 400)
  })

  it("agent 选项与可用性", async () => {
    const { body } = await request("GET", "/api/agents")
    assert.equal(body.default, "claude")
    assert.deepEqual(body.agents.map((a: any) => a.key), ["claude", "codex", "opencode", "workbuddy", "dsh"])
    assert.equal(body.fix_default, "dsh")
    assert.ok(body.agents.every((a: any) => "available" in a && a.label))
    // 编程 agent 也都能当审阅（dsh 本来就是固定选项，不重复）
    assert.deepEqual(body.reviewers.map((r: any) => r.key), ["auto", "api", "dsh", "claude", "codex", "opencode", "workbuddy", "skip"])
    assert.ok(body.reviewers.find((r: any) => r.key === "codex").label)
    assert.match(body.reviewers[0].label, /当前会用/)
    let r = await request("POST", "/api/runs", { graph: N.PIPELINE_NAME, input: { project_root: tempDir(), requirement: "x", coding_agent: "cursor" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的编程 agent：cursor"])
    r = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: tempDir(), fix_agent: "cursor" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的修复 agent：cursor"])
    r = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: tempDir(), review_backend: "gpt" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的审阅方式：gpt"])
    // 文档阶段的角色也能选：需求 / 技术设计 / 仲裁任一编程预设，看图只能 codex / claude
    assert.deepEqual(body.role_defaults, { product_agent: "claude", tech_agent: "codex", vision_agent: "codex", arbiter_agent: "dsh" })
    assert.deepEqual(body.vision_agents.map((a: any) => a.key), ["claude", "codex"])
    r = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: tempDir(), product_agent: "cursor" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的需求 agent：cursor"])
    r = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: tempDir(), vision_agent: "dsh" } })
    assert.match(r.body.error, /看图只支持 codex \/ claude/)
  })

  it("选文件夹与目录检查", async () => {
    const root = tempDir()
    writeFileSync(join(root, "package.json"), "{\"name\": \"my-app\"}")
    pick = root
    const { body } = await request("POST", "/api/pick-folder", { initial: null })
    assert.equal(body.path, root)
    assert.deepEqual([body.inspect.package_json, body.inspect.name, body.inspect.rules_yaml], [true, "my-app", false])
    pick = null
    assert.equal((await request("POST", "/api/pick-folder", {})).body.path, null)
    assert.equal((await request("POST", "/api/pick-file", {})).body.path, "/tmp/design.json")
  })

  it("生成配置：已有的不覆盖", async () => {
    const root = tempDir()
    writeFileSync(join(root, "agent.config.json"), "{}")
    const { status, body } = await request("POST", "/api/init", { path: root })
    assert.equal(status, 200)
    assert.deepEqual([body.created, body.skipped, body.inspect.rules_yaml], [["rules.yaml"], ["agent.config.json"], true])
    assert.equal(readFileSync(join(root, "agent.config.json"), "utf8"), "{}")
    assert.equal((await request("POST", "/api/init", { path: "" })).body.error, "请填写项目路径")
    assert.equal((await request("POST", "/api/init", { path: "Z:/nope" })).status, 400)
  })

  it("错误输入给中文提示", async () => {
    assert.deepEqual(Object.values(await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: {} })).slice(0, 2), [400, { error: "请填写项目路径" }])
    const r = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: "Z:/no/such/dir" } })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /不存在/)
    assert.equal((await request("POST", "/api/runs", { graph: "nope", input: {} })).status, 400)
  })

  it("修复回环：进度与门禁逐项输出进运行记录", async () => {
    const root = tempDir()
    writeFileSync(join(root, "rules.yaml"), rulesRunning("console.log('types ok')"))
    const { status, body } = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: root } })
    assert.equal(status, 201)
    const run = await waitRun(body.id)
    assert.equal(run.result.status, "delivered")
    assert.ok(run.result.summary.startsWith("已交付"))
    assert.deepEqual(run.events.filter((e: any) => e.type === "node_start").map((e: any) => e.node), [N.VERIFY, N.DELIVER])
    const logs = run.events.filter((e: any) => e.type === "log").map((e: any) => e.text).join("\n")
    assert.match(logs, /✔ typecheck/)
    assert.match(logs, /\[门禁\] 退出码 0/)
  })

  it("同一项目同时只能有一次运行", async () => {
    const root = tempDir()
    writeFileSync(join(root, "rules.yaml"), rulesRunning("setTimeout(()=>{},1500)"))
    const first = await request("POST", "/api/runs", { graph: GATE_ONLY, input: { project_root: root } })
    const second = await request("POST", "/api/runs", { graph: GATE_ONLY, input: { project_root: root } })
    assert.equal(second.status, 400)
    assert.match(second.body.error, /已有一次运行在进行中/)
    await waitRun(first.body.id)
  })

  it("工作空间：添加、偏好、打开目录、移除", async () => {
    const root = tempDir()
    writeFileSync(join(root, "package.json"), "{\"name\": \"shop-admin\"}")
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feature/login\n")
    const { status, body: ws } = await request("POST", "/api/workspaces/add", { path: root })
    assert.equal(status, 200)
    assert.deepEqual([ws.name, ws.branch, ws.inspect.rules_yaml, ws.last_run], ["shop-admin", "feature/login", false, null])
    assert.equal((await request("POST", "/api/workspaces/add", { path: `${root}/` })).body.path, ws.path) // 同一目录不重复加
    assert.equal((await request("GET", "/api/workspaces")).body.filter((w: any) => w.path === ws.path).length, 1)

    let r = await request("POST", "/api/workspaces/prefs", { path: ws.path, prefs: { coding_agent: "codex", review_backend: "skip" } })
    assert.deepEqual([r.status, r.body.prefs], [200, { coding_agent: "codex", review_backend: "skip" }])
    r = await request("POST", "/api/workspaces/prefs", { path: ws.path, prefs: { coding_agent: "" } })
    assert.deepEqual(r.body.prefs, { review_backend: "skip" }) // 空值 = 回到默认
    r = await request("POST", "/api/workspaces/prefs", { path: ws.path, prefs: { fix_agent: "cursor" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的修复 agent：cursor"])

    assert.equal((await request("POST", "/api/open", { path: ws.path })).status, 200)
    assert.equal(opened.at(-1), ws.path)
    r = await request("POST", "/api/open", { path: "/etc" }) // 只能打开已添加的工作空间
    assert.equal(r.status, 400)
    assert.match(r.body.error, /不是已添加的工作空间/)

    assert.equal((await request("POST", "/api/workspaces/remove", { path: ws.path })).status, 200)
    assert.equal((await request("GET", "/api/workspaces")).body.some((w: any) => w.path === ws.path), false)
    assert.ok(existsSync(join(root, "package.json"))) // 移除不删项目文件
    assert.equal((await request("POST", "/api/workspaces/add", { path: "Z:/no/such/dir" })).status, 400)
  })

  it("只跑门禁：结果落盘，服务重启后按项目仍能读回", async () => {
    const root = tempDir()
    writeFileSync(join(root, "rules.yaml"), rulesRunning("console.log('types ok')"))
    const { status, body } = await request("POST", "/api/runs", { graph: GATE_ONLY, input: { project_root: root } })
    assert.equal(status, 201)
    const run = await waitRun(body.id)
    assert.deepEqual([run.result.status, run.result.verify_exit], ["passed", 0])
    assert.deepEqual(run.events.filter((e: any) => e.type === "node_start").map((e: any) => e.node), [N.VERIFY])
    assert.ok(existsSync(join(root, ".agent", "runs", `${body.id}.json`)))

    c.store.runs.delete(body.id) // 模拟重启：内存里的记录没了
    const project = encodeURIComponent(root)
    assert.deepEqual((await request("GET", `/api/runs?project=${project}`)).body.map((r: any) => r.id), [body.id])
    const saved = await request("GET", `/api/runs/${body.id}?project=${project}&after=1`)
    assert.deepEqual([saved.status, saved.body.result.status, saved.body.next], [200, "passed", run.events.length])
    assert.equal(saved.body.events.length, run.events.length - 1)
    assert.equal((await request("GET", `/api/runs/${body.id}`)).status, 404) // 不带项目找不到落盘记录
  })

  it("设置：读写 .env、项目范围只认工作空间、未知检测报错", async () => {
    let r = await request("POST", "/api/settings", { scope: "user", values: { NOTIFY_EMAIL: "ops@example.com", SMTP_PASS: "secret-pass-123" } })
    assert.equal(r.status, 200)
    const item = (k: string) => r.body.items.find((i: any) => i.key === k)
    assert.deepEqual([item("NOTIFY_EMAIL").user, item("SMTP_PASS").user], ["ops@example.com", "sec…-123"])
    r = await request("GET", "/api/settings")
    assert.equal(item("SMTP_PASS").user, "sec…-123") // GET 也拿不到完整密钥
    assert.equal(JSON.stringify(r.body).includes("secret-pass-123"), false)
    r = await request("POST", "/api/settings", { scope: "user", values: { PATH: "x" } })
    assert.deepEqual([r.status, r.body.error], [400, "不支持的配置项：PATH"])
    r = await request("POST", "/api/settings", { scope: "project", project: tempDir(), values: {} })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /不是已添加的工作空间/)
    assert.equal((await request("POST", "/api/settings/test", { kind: "nope" })).status, 400)
    assert.equal((await request("POST", "/api/auth/login", { agent: "dsh" })).status, 400)
    await request("POST", "/api/settings", { scope: "user", values: { NOTIFY_EMAIL: "", SMTP_PASS: "" } })
  })

  it("完整流水线：编码里的子步骤（Spec、写代码）也上报", async () => {
    // Spec 走 OpenAI 兼容接口（本地假服务），编码 agent 是一段什么也不改的脚本
    const llm = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "# Spec" } }] }))
    })
    await new Promise<void>(r => llm.listen(0, "127.0.0.1", r))
    // 编码 agent 写一个文件；工作区是干净的 git 仓库
    const root = gitRepo({
      "rules.yaml": rulesRunning("console.log('types ok')"),
      "agent.config.json": JSON.stringify({
        spec: { backend: "openai_compatible", base_url: `http://127.0.0.1:${(llm.address() as AddressInfo).port}`, model: "m" },
        coding_agents: { dsh: { command: [process.execPath, "-e", "require('fs').writeFileSync('login.ts', 'export {}')", "{prompt}"] } },
        checkpoint: { enabled: false },
      }),
    })
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-test\n")
    try {
      await request("POST", "/api/workspaces/add", { path: root })
      // 文档阶段会调真实的 product / tech agent：这个用例只测作业分支，关掉它们
      W.setWorkflowOverrides(root, { stages: Object.fromEntries(DOC_STAGES.map(n => [n, { enabled: false }])) })
      const { body } = await request("POST", "/api/runs", { graph: N.PIPELINE_NAME, input: { project_root: root, requirement: "做登录页", coding_agent: "dsh" } })
      const run = await waitRun(body.id)
      const steps = run.events.filter((e: any) => e.type === "node_start").map((e: any) => [e.parent, e.node])
      assert.deepEqual(steps, [
        [null, N.CODE], [N.CODE, N.DESIGN], [N.CODE, N.SPEC], [N.CODE, N.WRITE_CODE],
        [null, N.VERIFY], [null, N.DELIVER], [null, N.REHEARSE],
      ])
      assert.equal(run.result.status, "delivered")
      assert.ok("changed_files" in run.result)
      // 计划事件带上每一步是谁做的，页面按它标注进度条和日志
      const plan = run.events.find((e: any) => e.type === "plan")
      assert.equal(plan.agents[N.WRITE_CODE], "DeepSeek Harness")
      assert.equal(plan.agents[N.VERIFY], "门禁脚本（无模型）")
      // 跑完已切回 main，作业分支待合并，默认目标的预演已通过
      assert.equal(gitOut(root, "symbolic-ref", "--short", "HEAD"), "main")
      assert.equal(run.flow.status, "ready_to_merge")
      assert.deepEqual(run.flow.rehearsal, { target: "main", passed: true })
      assert.equal(existsSync(join(root, "login.ts")), false)

      // 有待合并的运行时不许开新运行
      const blocked = await request("POST", "/api/runs", { graph: N.PIPELINE_NAME, input: { project_root: root, requirement: "y" } })
      assert.equal(blocked.status, 400)
      assert.deepEqual(blocked.body.problems.map((p: any) => p.code), ["PENDING"])

      // 合并弹窗：目标列表、默认目标；合并后删作业分支，main 前进一个 squash 提交
      const flow = (await request("GET", `/api/flow?project=${encodeURIComponent(root)}&run=${run.id}`)).body
      assert.equal(flow.default_target, "main")
      assert.deepEqual(flow.targets.map((t: any) => t.branch), ["main"])
      const merged = await request("POST", "/api/flow/merge", { project: root, run: run.id, target: "main" })
      assert.equal(merged.status, 200)
      assert.equal(merged.body.manifest.status, "merged")
      assert.equal(existsSync(join(root, "login.ts")), true)
      assert.equal(gitOut(root, "log", "-1", "--format=%s"), "做登录页")
      assert.equal(gitOut(root, "branch", "--list", run.flow.branch), "")
      const ws = (await request("GET", "/api/workspaces")).body.find((w: any) => w.path === root.replaceAll("\\", "/"))
      assert.equal(ws.lastMergeTarget, "main")
      assert.deepEqual(ws.pending_runs, [])
      // 落盘的运行记录（服务重启后读的就是它）里作业分支状态跟着 manifest 走
      c.store.runs.delete(run.id)
      const saved = (await request("GET", `/api/runs/${run.id}?project=${encodeURIComponent(root)}`)).body
      assert.equal(saved.flow.status, "merged")
    }
    finally {
      llm.close()
    }
  })

  it("开工检查没过：返回问题清单；.gitignore 可以一键修复", async () => {
    const root = gitRepo({ "app.ts": "" }, "node_modules/\n")
    await request("POST", "/api/workspaces/add", { path: root })
    const r = await request("POST", "/api/runs", { graph: N.PIPELINE_NAME, input: { project_root: root, requirement: "x" } })
    assert.equal(r.status, 400)
    assert.deepEqual(r.body.problems.map((p: any) => p.code), ["GITIGNORE"])
    const fixed = await request("POST", "/api/workspaces/fix-gitignore", { path: root })
    assert.equal(fixed.status, 200)
    assert.equal(gitOut(root, "log", "-1", "--format=%s"), "chore: 忽略 .agent/（web-workflow-kit 运行产物）")
    // 修复回环、仅门禁不拉作业分支，也就不要求这些
    assert.equal((await request("POST", "/api/runs", { graph: GATE_ONLY, input: { project_root: tempDir() } })).status, 201)
  })

  it("每一步是谁做的：按工作流角色和本次的选择算，没有模型的步骤也写明", () => {
    const cfg = loadConfig(tempDir())
    const a = stepAgents(cfg, { coding_agent: "workbuddy", fix_agent: "dsh", review_backend: "codex" })
    assert.equal(a[N.DISCOVERY], "Claude Code")
    assert.equal(a[N.TECH_DESIGN], "Codex")
    assert.equal(a[N.DOC_REVIEW], "Claude Code（仲裁：DeepSeek Harness）")
    assert.equal(a[N.WRITE_CODE], cfg.raw.coding_agents.workbuddy.label)
    assert.equal(a[N.ADVISE], "Codex")
    assert.equal(a[N.FIX], "DeepSeek Harness")
    assert.equal(a[N.ACCEPTANCE], "Claude Code")
    assert.equal(a[N.VERIFY], "门禁脚本（无模型）")
    assert.match(stepAgents(cfg, { images: ["/a.png"] })[N.DISCOVERY], /看图：Codex/)
    assert.equal(stepAgents(cfg, { review_backend: "skip" })[N.ADVISE], "跳过审阅")
    // 本次选的角色覆盖工作流配置
    const o = stepAgents(cfg, { product_agent: "codex", tech_agent: "claude", arbiter_agent: "workbuddy" })
    assert.deepEqual([o[N.DISCOVERY], o[N.TECH_DESIGN], o[N.ACCEPTANCE]], ["Codex", "Claude Code", "Codex"])
    assert.equal(o[N.DOC_REVIEW], `Codex（仲裁：${cfg.raw.coding_agents.workbuddy.label}）`)
  })

  it("三种输入：图片和设计稿二选一，图片要存在且是图片；图片选择器返回多个路径", async () => {
    const root = gitRepo({})
    const start = (input: Record<string, unknown>) => request("POST", "/api/runs", { graph: N.PIPELINE_NAME, input: { project_root: root, requirement: "x", ...input } })
    const png = join(root, "shot.png")
    writeFileSync(png, Buffer.from([1]))
    assert.match((await start({ images: [png], design_ref: "mastergo" })).body.error, /图片和设计稿二选一/)
    assert.match((await start({ images: [join(root, "nope.png")] })).body.error, /图片不存在/)
    assert.match((await start({ images: [join(root, ".gitignore")] })).body.error, /只支持图片/)
    assert.deepEqual((await request("POST", "/api/pick-images", {})).body, { paths: ["/tmp/a.png", "/tmp/b.jpg"] })
  })

  it("预览接口：开始、看状态拿地址、停止", async () => {
    // 服务代码写进文件：Windows 上 npm 用 cmd 跑脚本，node -e 里的转义引号 cmd 不认
    const server = join(tempDir(), "server.mjs")
    writeFileSync(server, "console.log('Local: http://localhost:5311/'); setInterval(() => {}, 1000)")
    const dev = `"${process.execPath}" "${server}"`
    const root = gitRepo({ "package.json": JSON.stringify({ name: "p", scripts: { dev } }) })
    await request("POST", "/api/workspaces/add", { path: root })
    const q = `/api/preview?project=${encodeURIComponent(root)}`
    assert.equal((await request("GET", q)).body.preview, null)
    assert.equal((await request("POST", "/api/preview/start", { project: root })).status, 202)
    let p: any
    for (let i = 0; i < 100 && p?.status !== "running"; i++) {
      await new Promise(r => setTimeout(r, 100))
      p = (await request("GET", q)).body.preview
    }
    assert.deepEqual([p.status, p.url], ["running", "http://localhost:5311/"])
    assert.equal((await request("POST", "/api/preview/stop", { project: root })).body.preview.status, "stopped")
  })

  it("作业分支接口只认已加入的工作空间；没有记录的运行返回 404", async () => {
    assert.equal((await request("GET", `/api/flow?project=${encodeURIComponent(tempDir())}&run=abc`)).status, 400)
    const root = gitRepo({})
    await request("POST", "/api/workspaces/add", { path: root })
    assert.equal((await request("GET", `/api/flow?project=${encodeURIComponent(root)}&run=abc`)).status, 404)
    assert.equal((await request("POST", "/api/flow/discard", { project: root, run: "abc" })).status, 400)
  })
})
