// 本地控制台（TS 版）：起一个真实的本地 HTTP 服务，按页面的方式调用（对应 Python 版 tests/test_ui.py）。
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import process from "node:process"
import { after, before, describe, it } from "node:test"
import { type ConsoleServer, GATE_ONLY, startConsole } from "../src/console/server.ts"
import * as N from "../src/names.ts"
import { tempDir } from "./helpers.ts"

/** 门禁只有一项 typecheck，命令是一段 node 脚本。 */
const rulesRunning = (code: string) =>
  `project_type: web\nprofiles:\n  web:\n    checks: [typecheck]\n    typecheck:\n      run: ${JSON.stringify(`"${process.execPath}" -e "${code}"`)}\n`

let c: ConsoleServer
const opened: string[] = []
let pick: string | null = null

before(async () => {
  c = await startConsole({ port: 0, picker: async () => pick, filePicker: async () => "/tmp/design.json", opener: p => opened.push(p) })
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
    assert.deepEqual(body.reviewers.map((r: any) => r.key), ["auto", "api", "dsh", "skip"])
    assert.match(body.reviewers[0].label, /当前会用/)
    let r = await request("POST", "/api/runs", { graph: N.PIPELINE_NAME, input: { project_root: tempDir(), requirement: "x", coding_agent: "cursor" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的编程 agent：cursor"])
    r = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: tempDir(), fix_agent: "cursor" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的修复 agent：cursor"])
    r = await request("POST", "/api/runs", { graph: N.FIX_LOOP_NAME, input: { project_root: tempDir(), review_backend: "gpt" } })
    assert.deepEqual([r.status, r.body.error], [400, "未知的审阅方式：gpt"])
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

  it("完整流水线：编码里的子步骤（Spec、写代码）也上报", async () => {
    // Spec 走 OpenAI 兼容接口（本地假服务），编码 agent 是一段什么也不改的脚本
    const llm = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "# Spec" } }] }))
    })
    await new Promise<void>(r => llm.listen(0, "127.0.0.1", r))
    const root = tempDir()
    writeFileSync(join(root, "rules.yaml"), rulesRunning("console.log('types ok')"))
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-test\n")
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({
      spec: { backend: "openai_compatible", base_url: `http://127.0.0.1:${(llm.address() as AddressInfo).port}`, model: "m" },
      coding_agents: { dsh: { command: [process.execPath, "-e", "0", "{prompt}"] } },
      checkpoint: { enabled: false },
    }))
    try {
      const { body } = await request("POST", "/api/runs", { graph: N.PIPELINE_NAME, input: { project_root: root, requirement: "x", coding_agent: "dsh" } })
      const run = await waitRun(body.id)
      const steps = run.events.filter((e: any) => e.type === "node_start").map((e: any) => [e.parent, e.node])
      assert.deepEqual(steps, [[null, N.CODE], [N.CODE, N.DESIGN], [N.CODE, N.SPEC], [N.CODE, N.WRITE_CODE], [null, N.VERIFY], [null, N.DELIVER]])
      assert.equal(run.result.status, "delivered")
      assert.ok("changed_files" in run.result)
    }
    finally {
      llm.close()
    }
  })
})
