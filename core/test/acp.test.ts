// ACP agent：权限策略与 stop_reason 映射（对应 Python 版 tests/test_integrations.py 的 ACP 部分）。
// 端到端用例走真实的 stdio + JSON-RPC，对端是 test/fixtures/stub-acp-agent.mjs。
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { ACPAgent, DEFAULT_ALLOW_KINDS, DEFAULT_PROTECTED, fnmatch, isAllowed, localAdapter, mapStopReason } from "../src/acp.ts"
import { END_TURN, ERROR, MAX_TOKENS } from "../src/agents.ts"
import { tempDir } from "./helpers.ts"

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-acp-agent.mjs")

describe("权限策略", () => {
  const root = tempDir()
  const check = (kind: string, ...paths: string[]) =>
    isAllowed({ kind, locations: paths.map(p => ({ path: join(root, p) })) }, root, DEFAULT_ALLOW_KINDS, DEFAULT_PROTECTED)[0]

  it("允许改源码、读门禁规则", () => {
    assert.ok(check("edit", "src/App.vue"))
    assert.ok(check("read", "rules.yaml"))
  })

  it("门禁与流水线文件改不了", () => {
    for (const p of ["rules.yaml", "verify/verify.ts", "agent.config.json", ".agent/spec.md", ".github/workflows/ci.yml", ".env", ".env.local"])
      assert.equal(check("edit", p), false, p)
  })

  it("写到项目外、执行命令、没有目标路径的写都拒绝", () => {
    assert.equal(check("edit", "../elsewhere.ts"), false)
    assert.equal(check("execute"), false)
    assert.deepEqual(isAllowed({ kind: "edit" }, root, DEFAULT_ALLOW_KINDS, DEFAULT_PROTECTED), [false, "write without a target path"])
    assert.match(isAllowed({ kind: "delete", locations: [{ path: "/etc/passwd" }] }, root, ["delete"], DEFAULT_PROTECTED)[1], /write outside project/)
  })

  it("fnmatch 的 * 跨目录匹配", () => {
    assert.ok(fnmatch("verify/lib/checks.ts", "verify/*"))
    assert.ok(fnmatch(".env.production", ".env.*"))
    assert.equal(fnmatch("src/.env.ts", ".env.*"), false)
  })

  it("stop_reason 映射", () => {
    assert.equal(mapStopReason("end_turn"), END_TURN)
    assert.equal(mapStopReason("max_turn_requests"), MAX_TOKENS)
    for (const r of ["refusal", "cancelled", undefined])
      assert.equal(mapStopReason(r), ERROR)
  })

  it("本机装了适配器命令就不经 npx", () => {
    const npx = ["npx", "--yes", "@agentclientprotocol/codex-acp@1.13.0"]
    assert.deepEqual(localAdapter(npx, { PATH: "" }), npx)
    const dir = dirname(process.execPath)
    const name = process.execPath.split(/[\\/]/).pop()!.replace(/\.exe$/i, "")
    const found = localAdapter(["npx", "--yes", `${name}@2.0`], { PATH: dir, PATHEXT: process.env.PATHEXT })!
    assert.equal(found.length, 1)
    assert.equal(found[0].toLowerCase(), process.execPath.toLowerCase()) // Windows 上按 PATHEXT 找到的是 node.EXE
    assert.deepEqual(localAdapter(["opencode", "acp"]), ["opencode", "acp"])
  })
})

describe("ACP agent（真实协议，对端是桩）", () => {
  async function runStub(writes: string, stop = "end_turn", extra: { model?: string, env?: Record<string, string> } = {}) {
    const root = tempDir()
    const agent = new ACPAgent({ agent: "stub", command: [process.execPath, STUB], timeoutSec: 60, model: extra.model,
      env: { ...process.env, STUB_WRITES: writes, STUB_STOP: stop, ...extra.env } })
    return { root, r: await agent.run("do it", root) }
  }

  it("权限策略在协议层生效：源码写成，门禁文件和项目外拒绝", async () => {
    const { root, r } = await runStub("src/a.ts;rules.yaml;verify/verify.ts;../outside.txt")
    assert.equal(r.stopReason, END_TURN)
    assert.ok(existsSync(join(root, "src/a.ts")))
    assert.equal(existsSync(join(root, "rules.yaml")), false)
    assert.equal(existsSync(join(root, "verify/verify.ts")), false)
    assert.equal(existsSync(join(root, "..", "outside.txt")), false)
    assert.match(r.text, /wrote=src\/a\.ts denied=rules\.yaml,verify\/verify\.ts,\.\.\/outside\.txt/)
    assert.match(r.text, /protected path: rules\.yaml/)
    assert.match(r.text, /write outside project/)
  })

  it("指定模型：会话开始后经 session/set_model 设上", async () => {
    assert.match((await runStub("")).r.text, /model=default/)
    assert.match((await runStub("", "end_turn", { model: "deepseek/deepseek-flash" })).r.text, /model=deepseek\/deepseek-flash/)
  })

  it("什么都没做却回 end_turn（0 token）：判为出错", async () => {
    const { r } = await runStub("", "end_turn", { env: { STUB_EMPTY: "1" } })
    assert.equal(r.stopReason, ERROR)
    assert.match(r.text, /没有任何输出.*登录失效、API Key 无效或模型不可用/)
  })

  it("refusal 映射为 error", async () => {
    assert.equal((await runStub("", "refusal")).r.stopReason, ERROR)
  })

  it("agent 起不来：返回 error，不崩", async () => {
    const r = await new ACPAgent({ agent: "stub", command: [join(dirname(STUB), "no_such_binary")], timeoutSec: 30 }).run("x", tempDir())
    assert.equal(r.stopReason, ERROR)
    assert.match(r.text, /ACP stub/)
  })

  it("超时：返回 error 并结束进程", async () => {
    const r = await new ACPAgent({ agent: "stub", command: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutSec: 1 }).run("x", tempDir())
    assert.equal(r.stopReason, ERROR)
    assert.match(r.text, /timed out after 1s/)
  })
})
