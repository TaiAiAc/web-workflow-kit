// 命令行：交互模式（经管道喂命令）、--version / --help、退出码。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { tempDir } from "./helpers.ts"

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..")
const wwk = (args: string[], input = "") =>
  spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: CORE, input, encoding: "utf8", env: { ...process.env } })

describe("命令行", () => {
  it("--version / --help 以 0 退出；不带命令又不在终端里时按用法错误退出", () => {
    const v = wwk(["--version"])
    assert.equal(v.status, 0)
    assert.match(v.stdout, /^web-workflow-kit /)
    assert.equal(wwk(["--help"]).status, 0)
    const none = wwk([])
    assert.equal(none.status, 2)
    assert.match(none.stderr, /不带命令进交互模式/)
    assert.equal(wwk(["nope"]).status, 2)
  })

  it("交互模式：管道喂命令，单条失败不退出", () => {
    const root = tempDir()
    writeFileSync(join(root, "rules.yaml"),
      `project_type: web\nprofiles:\n  web:\n    checks: [typecheck]\n    typecheck:\n      run: ${JSON.stringify(`"${process.execPath}" -e "console.log(1)"`)}\n`)
    const r = wwk(["repl", "--project", root], ":design login.json\n:verify\n:agent codex\n:status\n:resume\n:bogus\n:design off\n:q\n")
    assert.equal(r.status, 0)
    assert.match(r.stdout, /design = login\.json/)
    assert.match(r.stdout, /PASS/)
    assert.match(r.stdout, /编程 agent = codex/)
    assert.match(r.stdout, /\(还没有运行记录\)/)
    assert.match(r.stderr, /error: Error: no previous run to resume/) // 失败了也继续往下执行
    assert.match(r.stdout, /未知命令 :bogus/)
    assert.match(r.stdout, /design = null/)
  })
})
