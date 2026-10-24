// 配置加载与 agent 构建。
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { ACPAgent } from "../src/acp.ts"
import { agentAvailability, buildCodingAgent, ClaudeCodeCLI, CommandAgent, END_TURN, ERROR } from "../src/agents.ts"
import { DEFAULTS, loadConfig, render, userHome } from "../src/config.ts"
import { buildFixAgent } from "../src/deps.ts"
import { tempDir } from "./helpers.ts"

describe("配置", () => {
  it("项目 agent.config.json 深合并到默认值上", () => {
    const root = tempDir()
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({ max_retries: 2, review: { backend: "skip" } }))
    const cfg = loadConfig(root)
    assert.equal(cfg.maxRetries, 2)
    assert.equal(cfg.get("review").backend, "skip")
    assert.equal(cfg.get("review").model, DEFAULTS.review.model) // 没写的字段保留默认
    assert.equal(cfg.stateDir, join(root, ".agent"))
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

  it("max_retries 必须 ≥ 1", () => {
    const root = tempDir()
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({ max_retries: 0 }))
    assert.throws(() => loadConfig(root), /max_retries/)
  })

  it("模板替换：字符串原样，对象转 JSON", () => {
    assert.equal(render("a {x} b {y}", { x: "1", y: { k: [1] } }), "a 1 b {\n  \"k\": [\n    1\n  ]\n}")
  })
})

describe("agent", () => {
  it("编程 agent：默认 claude，未知名称报错", () => {
    const cfg = loadConfig(tempDir())
    assert.ok(buildCodingAgent(cfg) instanceof ClaudeCodeCLI)
    assert.ok(buildCodingAgent(cfg, "dsh") instanceof CommandAgent)
    assert.throws(() => buildCodingAgent(cfg, "cursor"), /未知的编程 agent/)
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
