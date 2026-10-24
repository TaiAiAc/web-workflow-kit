// 设置页的后端：.env 读写（密钥打码、只写不读）、agent 登录状态检测、终端登录命令、连通性探测。
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { parse } from "dotenv"
import { userHome } from "../src/config.ts"
import { agentStatuses, describeSettings, envFile, launchLogin, probe, saveSettings } from "../src/console/settings.ts"
import { tempDir } from "./helpers.ts"

const item = (d: any, key: string) => d.items.find((i: any) => i.key === key)

describe(".env 读写", () => {
  it("写全局 .env：密钥打码、普通值原样、空值删除、其余行保留", () => {
    mkdirSync(userHome(), { recursive: true })
    writeFileSync(envFile("user"), "# 我自己的注释\nOTHER_VAR=keep\n")
    saveSettings("user", null, { DEEPSEEK_API_KEY: "sk-1234567890abcd", HTTPS_PROXY: "http://127.0.0.1:7890", SMTP_PASS: "a b#c" })
    const text = readFileSync(envFile("user"), "utf8")
    assert.match(text, /# 我自己的注释\nOTHER_VAR=keep\n/)
    assert.equal(parse(text).SMTP_PASS, "a b#c") // 含空格和 # 的值加了引号，读回来不被截断
    if (process.platform !== "win32")
      assert.equal(statSync(envFile("user")).mode & 0o777, 0o600)

    let d: any = describeSettings(null)
    assert.equal(item(d, "DEEPSEEK_API_KEY").user, "sk-…abcd") // 只写不读
    assert.equal(item(d, "HTTPS_PROXY").user, "http://127.0.0.1:7890")
    assert.equal(item(d, "DEEPSEEK_API_KEY").source, "user")

    saveSettings("user", null, { DEEPSEEK_API_KEY: "", HTTPS_PROXY: "http://10.0.0.1:8080" })
    d = describeSettings(null)
    assert.equal(item(d, "DEEPSEEK_API_KEY").user, null)
    assert.equal(item(d, "HTTPS_PROXY").user, "http://10.0.0.1:8080")
    assert.match(readFileSync(envFile("user"), "utf8"), /OTHER_VAR=keep/)
    saveSettings("user", null, { HTTPS_PROXY: "", SMTP_PASS: "" })
  })

  it("项目 .env 覆盖全局；只接受目录里的变量，值里不能有换行", () => {
    const root = tempDir()
    saveSettings("user", null, { NOTIFY_EMAIL: "a@user" })
    saveSettings("project", root, { NOTIFY_EMAIL: "b@project" })
    const d: any = describeSettings(root)
    assert.deepEqual([item(d, "NOTIFY_EMAIL").user, item(d, "NOTIFY_EMAIL").project, item(d, "NOTIFY_EMAIL").source], ["a@user", "b@project", "project"])
    assert.throws(() => saveSettings("user", null, { PATH: "/evil" }), /不支持的配置项：PATH/)
    assert.throws(() => saveSettings("user", null, { SMTP_HOST: "a\nB=c" }), /不能包含换行/)
    assert.throws(() => saveSettings("project", null, {}), /未知的配置范围/)
    saveSettings("user", null, { NOTIFY_EMAIL: "" })
  })
})

describe("agent 登录状态", () => {
  it("按各 CLI 的状态命令判断；没装的给安装命令", async () => {
    const bin = tempDir()
    const node = JSON.stringify(process.execPath)
    const fake = (name: string, js: string) => {
      const file = join(bin, name)
      writeFileSync(file, `#!/bin/sh\nexec ${node} -e ${JSON.stringify(js)} -- "$@"\n`)
      chmodSync(file, 0o755)
    }
    fake("claude", `const a=process.argv.slice(1);if(a[0]==="--version")console.log("2.1.0 (Claude Code)");else console.log(JSON.stringify({loggedIn:true,email:"me@x.com"}))`)
    fake("codex", `const a=process.argv.slice(1);if(a[0]==="--version")console.log("codex-cli 0.1");else{console.log("Not logged in");process.exit(1)}`)
    fake("opencode", `const a=process.argv.slice(1);if(a[0]==="--version")console.log("1.0");else console.log("Credentials ~/x\\n2 credentials")`)
    const old = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, OPENAI: process.env.OPENAI_API_KEY }
    process.env.PATH = bin
    process.env.CODEX_HOME = tempDir() // 没有 config.toml：不算自定义模型服务
    delete process.env.OPENAI_API_KEY
    try {
      if (process.platform === "win32")
        return // 假 CLI 用的是 sh 脚本
      const byKey = Object.fromEntries((await agentStatuses(null)).map((a: any) => [a.key, a]))
      assert.deepEqual([byKey.claude.state, byKey.claude.detail, byKey.claude.version], ["ok", "已登录（me@x.com）", "2.1.0 (Claude Code)"])
      assert.deepEqual([byKey.codex.state, byKey.codex.detail], ["login", "未登录"])
      assert.deepEqual([byKey.opencode.state, byKey.opencode.detail], ["ok", "已配置 2 个模型服务商"])
      assert.deepEqual([byKey.workbuddy.state, byKey.workbuddy.installed, byKey.workbuddy.install], ["missing", false, "npm install -g @tencent-ai/codebuddy-code"])
      assert.equal(byKey.dsh.state, "missing")
    }
    finally {
      process.env.PATH = old.PATH
      if (old.CODEX_HOME === undefined)
        delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = old.CODEX_HOME
      if (old.OPENAI !== undefined)
        process.env.OPENAI_API_KEY = old.OPENAI
    }
  })

  it("终端登录：带上配置的代理；没有登录步骤或没装的给出原因", () => {
    const root = tempDir()
    writeFileSync(join(root, ".env"), "HTTPS_PROXY=http://127.0.0.1:7890\n")
    const lines: string[] = []
    const bin = tempDir()
    writeFileSync(join(bin, process.platform === "win32" ? "claude.cmd" : "claude"), "")
    if (process.platform !== "win32")
      chmodSync(join(bin, "claude"), 0o755)
    const oldPath = process.env.PATH
    process.env.PATH = bin
    try {
      const line = launchLogin("claude", root, l => lines.push(l))
      assert.equal(lines[0], line)
      assert.match(line, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890/)
      assert.match(line, /claude auth login$/)
      assert.throws(() => launchLogin("dsh", root, () => {}), /没有登录步骤/)
      assert.throws(() => launchLogin("codex", root, () => {}), /未找到 codex 命令/)
      assert.throws(() => launchLogin("cursor", root, () => {}), /未知的 agent/)
    }
    finally {
      process.env.PATH = oldPath
    }
  })
})

describe("连通性探测", () => {
  it("代理连不上、目标不通都给出原因，不抛错", async () => {
    const viaDeadProxy = await probe("https://api.deepseek.com/", "http://127.0.0.1:9")
    assert.equal(viaDeadProxy.ok, false)
    assert.match(viaDeadProxy.error!, /连不上代理/)
    const deadTarget = await probe("https://127.0.0.1:9/", undefined)
    assert.deepEqual([deadTarget.ok, deadTarget.status], [false, null])
  })
})
