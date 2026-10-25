// 配置加载与 agent 构建。
import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { ACPAgent } from "../src/acp.ts"
import { agentAvailability, buildCodingAgent, ClaudeCodeCLI, CommandAgent, END_TURN, ERROR } from "../src/agents.ts"
import {
  DEFAULTS, type Layer, loadConfig, REDACTED, redact, render, resolveWorkflow, saveUserWorkflow, userHome,
  userWorkflowFile, WORKFLOW_DEFAULTS, writeSnapshot,
} from "../src/config.ts"
import * as W from "../src/console/workspaces.ts"
import { buildFixAgent, defaultDeps } from "../src/deps.ts"
import { tempDir } from "./helpers.ts"

type Json = Record<string, any>

describe("配置", () => {
  it("项目 agent.config.json 深合并到默认值上", () => {
    const root = tempDir()
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({ state_dir: ".wwk", review: { backend: "skip" } }))
    const cfg = loadConfig(root)
    assert.equal(cfg.get("review").backend, "skip")
    assert.equal(cfg.get("review").model, DEFAULTS.review.model) // 没写的字段保留默认
    assert.equal(cfg.stateDir, join(root, ".wwk"))
  })

  it(".env：项目覆盖用户级，并注入子进程环境", () => {
    const root = tempDir()
    writeFileSync(join(userHome(), ".env"), "SMTP_HOST=user.example\nNOTIFY_EMAIL=a@b\n")
    writeFileSync(join(root, ".env"), "SMTP_HOST=project.example\n")
    const cfg = loadConfig(root)
    assert.equal(cfg.secret("SMTP_HOST"), "project.example")
    assert.equal(cfg.secret("NOTIFY_EMAIL"), "a@b")
    assert.equal(cfg.childEnv().SMTP_HOST, "project.example")
    const env = cfg.childEnv()
    assert.equal(env.PATH ?? env.Path, process.env.PATH) // Windows 上复制出来的键名是 Path
  })

  it("max_retries 已移到工作流配置：agent.config.json 里还写着就报错并指路", () => {
    const root = tempDir()
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({ max_retries: 5 }))
    assert.throws(() => loadConfig(root), /limits\.max_retries/)
    assert.equal(loadConfig(tempDir()).maxRetries, WORKFLOW_DEFAULTS.limits.max_retries)
  })

  it("模板替换：字符串原样，对象转 JSON", () => {
    assert.equal(render("a {x} b {y}", { x: "1", y: { k: [1] } }), "a 1 b {\n  \"k\": [\n    1\n  ]\n}")
  })
})

describe("工作流配置", () => {
  const D: [Layer, Json] = ["default", WORKFLOW_DEFAULTS]
  // 用户级通用配置是全局文件：每个用例写完就删，不串到别的用例
  const userWorkflow = (data: Json, t: { after: (fn: () => void) => void }): void => {
    writeFileSync(userWorkflowFile(), JSON.stringify(data))
    t.after(() => rmSync(userWorkflowFile(), { force: true }))
  }

  it("包内默认值本身合法，来源全是 default", () => {
    const wf = resolveWorkflow([D])
    assert.deepEqual(wf.raw, WORKFLOW_DEFAULTS)
    assert.equal(wf.origin["stages.gate.install_command"], "default")
    assert.ok(Object.values(wf.origin).every(l => l === "default"))
  })

  it("合并语义：对象深合并、数组整体替换、null 照写，并记录每个字段的来源", () => {
    const wf = resolveWorkflow([
      D,
      ["user", { roles: { dev: { agent: "codex" } }, documents: { tags: ["a", "b", "c"] }, stages: { gate: { install_command: "pnpm i" } } }],
      ["workspace", { documents: { tags: ["z"] }, stages: { gate: { install_command: null } } }],
    ])
    assert.equal(wf.raw.roles.dev.agent, "codex")
    assert.equal(wf.raw.roles.product.agent, "claude") // 没写的保留
    assert.deepEqual(wf.raw.documents.tags, ["z"]) // 数组不拼接
    assert.equal(wf.raw.stages.gate.install_command, null)
    assert.equal(wf.raw.stages.gate.order, 50)
    assert.equal(wf.origin["roles.dev.agent"], "user")
    assert.equal(wf.origin["documents.tags"], "workspace")
    assert.equal(wf.origin["stages.gate.install_command"], "workspace")
    assert.equal(wf.origin["stages.gate.order"], "default")
  })

  it("对象换成叶子时，下面的旧来源作废", () => {
    const wf = resolveWorkflow([D, ["user", { input_modes: { text: "none" } }]])
    assert.equal(wf.origin["input_modes.text"], "user")
    assert.equal(wf.origin["input_modes.text.intake"], undefined)
  })

  it("enabled:false 关掉的阶段不参与 order 查重", () => {
    const moved = { stages: { acceptance: { order: 50 } } }
    assert.throws(() => resolveWorkflow([D, ["workspace", moved]]), /stages\.\S+\.order 与 stages\.\S+ 重复：50/)
    const wf = resolveWorkflow([D, ["workspace", { stages: { ...moved.stages, acceptance: { enabled: false } } }]])
    assert.equal(wf.raw.stages.acceptance.enabled, false)
  })

  it("校验一次列出所有问题", () => {
    const bad = {
      roles: { tech: { agent: "" } },
      stages: { "doc-review": { max_rounds: 0, role: "nobody" } },
      git: { merge_method: "rebase" },
      limits: { max_retries: 0 },
    }
    assert.throws(() => resolveWorkflow([D, ["user", bad]]), (e: Error) => {
      for (const msg of ["roles.tech.agent", "max_rounds", "role 不在 roles 里：nobody", "merge_method", "limits.max_retries"])
        assert.ok(e.message.includes(msg), `缺少：${msg}\n${e.message}`)
      return true
    })
  })

  it("loadConfig：用户级通用配置 + 本工作区覆盖，别的项目不受影响", (t) => {
    userWorkflow({ roles: { arbiter: { agent: "claude" } }, limits: { max_retries: 4 } }, t)
    const root = tempDir()
    const other = tempDir()
    W.add(root)
    W.add(other)
    W.setWorkflowOverrides(root, { limits: { max_retries: 2 } })
    const wf = loadConfig(root).workflow
    assert.equal(wf.raw.roles.arbiter.agent, "claude")
    assert.equal(wf.raw.limits.max_retries, 2)
    assert.equal(wf.origin["limits.max_retries"], "workspace")
    assert.equal(wf.origin["roles.arbiter.agent"], "user")
    assert.equal(loadConfig(other).workflow.raw.limits.max_retries, 4)
  })

  it("通用配置写坏了不影响加载 agent.config.json，用到工作流时才报错", (t) => {
    userWorkflow({ git: { merge_method: "rebase" } }, t)
    const cfg = loadConfig(tempDir())
    assert.equal(cfg.get("review").model, DEFAULTS.review.model)
    assert.throws(() => cfg.workflow, /merge_method/)
  })

  it("覆盖不合法就不存；空对象 = 完全继承", () => {
    const root = tempDir()
    W.add(root)
    assert.throws(() => W.setWorkflowOverrides(root, { stages: { gate: { order: "x" } } }), /order 必须是数字/)
    assert.equal(W.find(root)?.workflowOverrides, undefined)
    W.setWorkflowOverrides(root, { limits: { max_retries: 5 } })
    W.setWorkflowOverrides(root, {})
    assert.equal(W.find(root)?.workflowOverrides, undefined)
  })

  it("通用配置和某个工作区的覆盖合不出合法配置时拒绝保存", (t) => {
    t.after(() => rmSync(userWorkflowFile(), { force: true }))
    const root = tempDir()
    W.add(root)
    W.setWorkflowOverrides(root, { stages: { acceptance: { order: 55 } } })
    t.after(() => W.setWorkflowOverrides(root, {}))
    // 单独看合法，和工作区的 acceptance 撞了 order
    assert.throws(() => saveUserWorkflow({ stages: { gate: { order: 55 } } }), /与工作区 .* 的覆盖合并后不合法：[\s\S]*重复：55/)
    assert.ok(!existsSync(userWorkflowFile()))
  })

  it("阶段只认注册表里的七个；门禁不能关；顺序不能改", () => {
    assert.throws(() => resolveWorkflow([D, ["user", { stages: { lint: { order: 55, kind: "verify" } } }]]), /stages\.lint：未知阶段/)
    assert.throws(() => resolveWorkflow([D, ["user", { stages: { gate: { enabled: false } } }]]), /门禁是唯一的放行依据/)
    assert.throws(() => resolveWorkflow([D, ["user", { stages: { "tech-design": { order: 45 } } }]]),
      /阶段顺序不能改，应为 discovery → tech-design → doc-review → implement → impl-review → gate → acceptance/)
    // 关掉的阶段不参与顺序检查（复核依赖技术设计，一起关）
    resolveWorkflow([D, ["user", { stages: { "tech-design": { order: 45, enabled: false }, "doc-review": { enabled: false }, "impl-review": { enabled: false } } }]])
  })

  it("阶段间的依赖：技术设计 / 验收要 02，复核要 03", () => {
    assert.throws(() => resolveWorkflow([D, ["user", { stages: { "tech-design": { enabled: false } } }]]), (e: Error) =>
      /开着 doc-review 就不能关 tech-design/.test(e.message) && /开着 impl-review 就不能关 tech-design/.test(e.message))
    assert.throws(() => resolveWorkflow([D, ["user", { stages: { implement: { enabled: false } } }]]), /开着 impl-review 就不能关 implement/)
    assert.throws(() => resolveWorkflow([D, ["user", { stages: { discovery: { enabled: false } } }]]), (e: Error) =>
      /开着 tech-design 就不能关 discovery/.test(e.message) && /开着 acceptance 就不能关 discovery/.test(e.message))
    // 只留编码 ⇄ 门禁（第一阶段的流程）是合法的
    resolveWorkflow([D, ["user", { stages: Object.fromEntries(["discovery", "tech-design", "doc-review", "impl-review", "acceptance"].map(n => [n, { enabled: false }])) }]])
  })

  it("文件夹搬家后重新绑定，偏好和覆盖跟着走", () => {
    const oldRoot = tempDir()
    const newRoot = tempDir()
    W.add(oldRoot)
    W.setPrefs(oldRoot, { coding_agent: "codex" })
    W.setWorkflowOverrides(oldRoot, { limits: { max_retries: 2 } })
    W.rebind(oldRoot, newRoot)
    assert.equal(W.find(oldRoot), undefined)
    assert.equal(W.find(newRoot)?.prefs.coding_agent, "codex")
    assert.equal(loadConfig(newRoot).workflow.raw.limits.max_retries, 2)
    assert.throws(() => W.rebind(newRoot, join(newRoot, "missing")), /不存在/)
  })
})

describe("快照与导出脱敏", () => {
  const KEY = "sk-user-secret-123456"
  const PASS = "smtp-pass-abcdef"
  const INLINE = "sk-inline-999999"

  it("快照不含任何密钥值，只记密钥来自哪个文件的哪个键", (t) => {
    writeFileSync(join(userHome(), ".env"), `DEEPSEEK_API_KEY=${KEY}\n`)
    t.after(() => rmSync(join(userHome(), ".env"), { force: true }))
    const root = tempDir()
    writeFileSync(join(root, ".env"), `SMTP_PASS=${PASS}\nSMTP_HOST=smtp.example\n`)
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({
      review: { api_key: INLINE }, // 有人把 Key 直接写进了配置
      coding_agents: { dsh: { env: { DEEPSEEK_API_KEY: KEY, EXTRA: `Bearer ${KEY}` } } },
    }))
    const path = writeSnapshot(loadConfig(root), "abc123")
    assert.equal(path, join(root, ".agent", "runs", "abc123", "config.snapshot.json"))
    const text = readFileSync(path, "utf8")
    for (const secret of [KEY, PASS, INLINE])
      assert.ok(!text.includes(secret), `快照里出现了密钥 ${secret}`)
    const snap = JSON.parse(text)
    assert.equal(snap.agent_config.review.api_key, REDACTED)
    assert.equal(snap.agent_config.coding_agents.dsh.env.EXTRA, REDACTED) // 值里含已知密钥也打码
    assert.equal(snap.agent_config.review.api_key_env, "DEEPSEEK_API_KEY") // 变量名不是密钥，保留
    assert.match(snap.env.DEEPSEEK_API_KEY, /\.env$/)
    assert.equal(snap.env.SMTP_PASS, ".env")
    assert.equal(snap.env.SMTP_HOST, ".env")
    assert.equal(snap.origin["limits.max_retries"], "default")
    assert.equal(snap.workflow.git.merge_method, "squash")
  })

  it("redact：字段名像密钥的打码，存放密钥的变量名不动", () => {
    const out = redact({ apiKey: "x1", SMTP_PASS: "x2", access_token: "x3", password: "x4", api_key_env: "K", env_keys: ["A"], max_tokens: 5, token_budget: 0 })
    assert.deepEqual(out, { apiKey: REDACTED, SMTP_PASS: REDACTED, access_token: REDACTED, password: REDACTED, api_key_env: "K", env_keys: ["A"], max_tokens: 5, token_budget: 0 })
  })

  it("导出不含密钥；导入只覆盖本机已有的工作区，其余跳过", (t) => {
    writeFileSync(join(userHome(), ".env"), `OPENAI_API_KEY=${KEY}\n`)
    t.after(() => rmSync(join(userHome(), ".env"), { force: true }))
    t.after(() => rmSync(userWorkflowFile(), { force: true }))
    const root = tempDir()
    W.add(root)
    saveUserWorkflow({ roles: { tech: { agent: "claude" } }, vision: { token: INLINE, note: `key=${KEY}` } })
    W.setWorkflowOverrides(root, { limits: { max_retries: 2 } })
    const exported = W.exportWorkflow()
    const text = JSON.stringify(exported)
    assert.ok(!text.includes(KEY) && !text.includes(INLINE))
    assert.equal(exported.workflow.roles.tech.agent, "claude")

    rmSync(userWorkflowFile())
    W.setWorkflowOverrides(root, {})
    const r = W.importWorkflow({ ...exported, workspaces: [...exported.workspaces, { path: "/not/here", workflowOverrides: {} }] })
    assert.ok(r.workspaces.includes(W.normalize(root)))
    assert.deepEqual(r.skipped, ["/not/here"])
    const wf = loadConfig(root).workflow.raw
    assert.equal(wf.roles.tech.agent, "claude")
    assert.equal(wf.limits.max_retries, 2)
    assert.throws(() => W.importWorkflow({ kind: "other" }), /不是 web-workflow-kit 导出/)
  })
})

describe("agent", () => {
  it("编程 agent：默认 claude，未知名称报错", () => {
    const cfg = loadConfig(tempDir())
    assert.ok(buildCodingAgent(cfg) instanceof ClaudeCodeCLI)
    assert.ok(buildCodingAgent(cfg, "dsh") instanceof CommandAgent)
    assert.throws(() => buildCodingAgent(cfg, "cursor"), /未知的编程 agent/)
  })

  it("按角色覆盖模型和思考强度：CLI 参数、WorkBuddy ACP 启动参数，dsh 直接拒绝", () => {
    const cfg = loadConfig(tempDir())
    const claude = buildCodingAgent(cfg, "claude", { model: "opus", effort: "high" }) as ClaudeCodeCLI
    assert.deepEqual([claude.model, claude.effort], ["opus", "high"])
    const wb = buildCodingAgent(cfg, "workbuddy", { model: "hy3", effort: "max" }) as ACPAgent
    assert.match(wb.command!.join(" "), /--model hy3 --effort max/)
    assert.deepEqual([wb.model, wb.effort], [null, null])
    assert.throws(() => buildCodingAgent(cfg, "dsh", { model: "deepseek-chat" }), /不支持选择模型/)
    assert.throws(() => buildCodingAgent(cfg, "opencode", { effort: "high" }), /只提供模型列表/)
  })

  it("ACP 预设：codex 用内置适配器，opencode 用自带命令", () => {
    const cfg = loadConfig(tempDir())
    const codex = buildCodingAgent(cfg, "codex") as ACPAgent
    assert.ok(codex instanceof ACPAgent)
    assert.deepEqual([codex.agent, codex.command], ["codex", null])
    const opencode = buildCodingAgent(cfg, "opencode") as ACPAgent
    assert.deepEqual([opencode.agent, opencode.command], ["opencode", ["opencode", "acp"]])
  })

  it("WorkBuddy 预设：只给文件工具（没有 Bash），关掉自动记忆（不往项目外写）", () => {
    const wb = buildCodingAgent(loadConfig(tempDir()), "workbuddy") as ACPAgent
    assert.deepEqual(wb.command, ["codebuddy", "--acp", "--tools", "Read,Glob,Grep,Edit,MultiEdit,Write,TodoWrite"])
    assert.equal(wb.env?.CODEBUDDY_DISABLE_AUTO_MEMORY, "1")
    // 预设的 env 是追加，不是替换（Windows 上叫 Path 不叫 PATH，所以逐个比对继承来的变量名）
    for (const k of Object.keys(process.env))
      assert.ok(k in wb.env!, `missing inherited ${k}`)
  })

  it("修复 agent：默认用 fix 段，选了预设就用预设", () => {
    const cfg = loadConfig(tempDir())
    const fix = buildFixAgent(cfg) as CommandAgent
    assert.ok(fix instanceof CommandAgent)
    assert.ok(fix.taskFile.endsWith("fix-task.md"))
    assert.ok(buildFixAgent(cfg, "claude") instanceof ClaudeCodeCLI)
    assert.throws(() => buildFixAgent(cfg, "cursor"), /未知的修复 agent/)
  })

  it("每次运行按角色把 model / effort 传到对应 agent", () => {
    const deps = defaultDeps(loadConfig(tempDir()), {
      selections: {
        coding: { agent: "claude", model: "opus", effort: "high" },
        product: { agent: "claude", model: "sonnet", effort: "low" },
        fix: { agent: "claude", model: "opus", effort: "max" },
      },
    })
    const coder = deps.coder as ClaudeCodeCLI
    const fixer = deps.fixer as ClaudeCodeCLI
    const product = deps.roleAgent!("product").agent as ClaudeCodeCLI
    assert.deepEqual([coder.model, coder.effort], ["opus", "high"])
    assert.deepEqual([fixer.model, fixer.effort], ["opus", "max"])
    assert.deepEqual([product.model, product.effort], ["sonnet", "low"])
  })

  it("命令行 agent：长 prompt 写进任务文件，命令行只传一句指令", async () => {
    const root = tempDir()
    const script = join(root, "echo.mjs")
    writeFileSync(script, "console.log('ARG=' + process.argv[2])")
    const agent = new CommandAgent([process.execPath, script, "{prompt}"], join(root, ".agent", "fix-task.md"))
    const r = await agent.run("修好 TYPECHECK_FAIL", root)
    assert.equal(r.stopReason, END_TURN)
    assert.match(r.text, /ARG=Read \.agent\/fix-task\.md and carry out the task it describes, then stop\./)
    assert.equal(readFileSync(join(root, ".agent", "fix-task.md"), "utf8"), "修好 TYPECHECK_FAIL")
    assert.equal((await new CommandAgent(["definitely-not-installed-xyz"], join(root, "t.md")).run("x", root)).stopReason, ERROR)
  })

  it("可用性只看命令在不在 PATH 上", () => {
    assert.deepEqual(agentAvailability({ requires: "definitely-not-installed-xyz" }), [false, "未找到 definitely-not-installed-xyz 命令"])
    assert.equal(agentAvailability({ requires: process.execPath })[0], true)
  })
})
