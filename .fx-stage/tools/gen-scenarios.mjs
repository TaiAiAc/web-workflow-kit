#!/usr/bin/env node
// 生成 scenarios/ 下的全部测试素材。素材是「数据」，手写几十个文件容易不一致，
// 所以统一在这里定义、一次生成；改完重跑 `node tools/gen-scenarios.mjs` 即可重建。
//
// 约束（离线可跑）：所有命令检查只用 `node scripts/xxx.mjs`，
// 不依赖 pnpm / npm / tsc / eslint / vitest，也不需要联网安装依赖。
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, "..", "scenarios")

const CASES = []
const add = (name, expected, files) => CASES.push({ name, expected, files })

// ---------------------------------------------------------------- 公共片段

const gitignore = `node_modules/
dist/
build/
.agent/
*.log
`

const pkg = (name, version = "1.0.0", extra = {}) =>
  JSON.stringify({ name, version, private: true, type: "module", ...extra }, null, 2) + "\n"

// 全部通过的三个质量门禁：输出保持真实工具的样子，方便肉眼对照
const okScript = (label) => `console.log("[${label}] 0 个问题")
process.exit(0)
`

const okRules = `version: 1
project_type: web
defaults:
  timeout_sec: 120
  max_detail_chars: 3000
  fail_fast: false
commands:
  typecheck:
    run: node scripts/typecheck.mjs
  lint:
    run: node scripts/lint.mjs
  test:
    run: node scripts/test.mjs
profiles:
  web:
    checks: [typecheck, lint, test, build, artifacts]
    build:
      run: node scripts/build.mjs
    artifacts:
      dir: dist
      required: [index.html, assets/app.js]
`

const okScripts = {
  "scripts/typecheck.mjs": okScript("typecheck"),
  "scripts/lint.mjs": okScript("lint"),
  "scripts/test.mjs": okScript("test"),
}

const buildWebOk = `import { mkdirSync, writeFileSync } from "node:fs"

mkdirSync("dist/assets", { recursive: true })
writeFileSync("dist/index.html", '<!doctype html>\\n<html lang="zh-CN">\\n  <head><meta charset="utf-8" /><title>登录</title></head>\\n  <body><div id="app"></div><script src="/assets/app.js"></script></body>\\n</html>\\n')
writeFileSync("dist/assets/app.js", 'console.log("vite build output")\\n')
console.log("[build] 构建完成，产物写入 dist/")
`

const sources = {
  "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"

createApp(App).mount("#app")
`,
  "src/App.vue": `<script setup lang="ts">
import LoginPage from "./views/LoginPage.vue"
</script>

<template>
  <LoginPage />
</template>
`,
  "src/views/LoginPage.vue": `<script setup lang="ts">
import { ref } from "vue"
import { sendCode, submitLogin } from "../api/login"

const phone = ref("")
const code = ref("")
const countdown = ref(0)
const error = ref("")

async function onSendCode() {
  try {
    await sendCode(phone.value)
    countdown.value = 60
  } catch (e) {
    error.value = "验证码发送失败，请稍后重试"
  }
}

async function onSubmit() {
  try {
    await submitLogin({ phone: phone.value, code: code.value })
  } catch (e) {
    error.value = "手机号或验证码不正确"
  }
}
</script>

<template>
  <form class="login" @submit.prevent="onSubmit">
    <input v-model="phone" placeholder="手机号" />
    <input v-model="code" placeholder="验证码" />
    <button type="button" :disabled="countdown > 0" @click="onSendCode">
      {{ countdown > 0 ? countdown + "s" : "获取验证码" }}
    </button>
    <button type="submit">登录</button>
    <p v-if="error" class="error">{{ error }}</p>
  </form>
</template>

<style scoped>
.login {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.error {
  color: #d92d20;
}
</style>
`,
  "src/api/login.ts": `export interface LoginForm {
  phone: string
  code: string
}

export interface LoginResult {
  token: string
}

export async function sendCode(phone: string): Promise<void> {
  await fetch("/api/sms/code", { method: "POST", body: JSON.stringify({ phone }) })
}

export async function submitLogin(form: LoginForm): Promise<LoginResult> {
  const res = await fetch("/api/login", { method: "POST", body: JSON.stringify(form) })
  return (await res.json()) as LoginResult
}
`,
  "tests/login.spec.ts": `import { describe, expect, it } from "vitest"
import { submitLogin } from "../src/api/login"

describe("登录", () => {
  it("验证码正确时返回 token", async () => {
    const r = await submitLogin({ phone: "13800000000", code: "123456" })
    expect(r.token).toBeTruthy()
  })
})
`,
}

// ---------------------------------------------------------------- 01 全绿

add(
  "01-web-pass",
  {
    kind: "gate",
    desc: "web 全绿：五项检查全通过，门禁放行并产出 dist",
    exit: 0,
    codes: [],
    statuses: { typecheck: "pass", lint: "pass", test: "pass", build: "pass", artifacts: "pass" },
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-web-pass"),
    ".gitignore": gitignore,
    "rules.yaml": okRules,
    ...okScripts,
    "scripts/build.mjs": buildWebOk,
    ...sources,
  },
)

// ---------------------------------------------------------------- 02 类型检查失败

add(
  "02-typecheck-fail",
  {
    kind: "gate",
    desc: "类型检查失败：TYPECHECK_FAIL 带 src 文件行列号，其余检查照跑",
    exit: 1,
    codes: ["TYPECHECK_FAIL"],
    statuses: { typecheck: "fail", lint: "pass", test: "pass", build: "pass", artifacts: "pass" },
    locations: ["src/api/login.ts:9:15", "src/views/LoginPage.vue:21:5"],
    messages: ["exited with 1"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-typecheck-fail"),
    ".gitignore": gitignore,
    "rules.yaml": okRules,
    ...okScripts,
    "scripts/typecheck.mjs": `console.log("src/api/login.ts(9,15): error TS2551: Property 'submmit' does not exist on type 'LoginForm'. Did you mean 'submit'?")
console.log("src/views/LoginPage.vue(21,5): error TS2322: Type 'number' is not assignable to type 'string'.")
console.log("Found 2 errors in 2 files.")
process.exit(1)
`,
    "scripts/build.mjs": buildWebOk,
    ...sources,
    // 故意留一个真实可修的 typo：下游 agent 拿 locations 就能定位
    "src/api/login.ts": `export interface LoginForm {
  phone: string
  code: string
}

export interface LoginResult {
  token: string
}

export async function submitLogin(form: LoginForm): Promise<LoginResult> {
  const res = await fetch("/api/login", { method: "POST", body: JSON.stringify(form.submmit) })
  return (await res.json()) as LoginResult
}
`,
    "src/views/LoginPage.vue": sources["src/views/LoginPage.vue"].replace(
      'await submitLogin({ phone: phone.value, code: code.value })',
      'await submitLogin({ phone: Number(phone.value), code: code.value })',
    ),
  },
)

// ---------------------------------------------------------------- 03 lint 失败

add(
  "03-lint-fail",
  {
    kind: "gate",
    desc: "lint 失败：LINT_FAIL，带 eslint 风格的规则名与行列号",
    exit: 1,
    codes: ["LINT_FAIL"],
    statuses: { typecheck: "pass", lint: "fail", test: "pass", build: "pass", artifacts: "pass" },
    locations: ["src/api/login.ts:5:3", "src/views/LoginPage.vue:8:7"],
    messages: ["exited with 1"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-lint-fail"),
    ".gitignore": gitignore,
    "rules.yaml": okRules,
    ...okScripts,
    "scripts/lint.mjs": `console.log("src/views/LoginPage.vue(8,7): error  vue/no-unused-vars  'countdown' is assigned a value but never used")
console.log("src/api/login.ts(5,3): error  @typescript-eslint/no-explicit-any  Unexpected any. Specify a different type")
console.log("\\u2716 2 problems (2 errors, 0 warnings)")
process.exit(1)
`,
    "scripts/build.mjs": buildWebOk,
    ...sources,
  },
)

// ---------------------------------------------------------------- 04 单测失败

add(
  "04-test-fail",
  {
    kind: "gate",
    desc: "单测失败：TEST_FAIL，带测试文件行列号",
    exit: 1,
    codes: ["TEST_FAIL"],
    statuses: { typecheck: "pass", lint: "pass", test: "fail", build: "pass", artifacts: "pass" },
    locations: ["tests/login.spec.ts:12:5"],
    messages: ["exited with 1"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-test-fail"),
    ".gitignore": gitignore,
    "rules.yaml": okRules,
    ...okScripts,
    "scripts/test.mjs": `console.log(" FAIL  tests/login.spec.ts > 登录 > 验证码正确时返回 token")
console.log("AssertionError: expected undefined to be truthy")
console.log(" \\u276f tests/login.spec.ts:12:5")
console.log(" Tests  1 failed (1)")
process.exit(1)
`,
    "scripts/build.mjs": buildWebOk,
    ...sources,
  },
)

// ---------------------------------------------------------------- 05 构建失败 → 产物检查跳过

add(
  "05-build-fail",
  {
    kind: "gate",
    desc: "构建失败：BUILD_FAIL，artifacts 因依赖 build 被标为 skip（reason: build failed）",
    exit: 1,
    codes: ["BUILD_FAIL"],
    statuses: { typecheck: "pass", lint: "pass", test: "pass", build: "fail", artifacts: "skip" },
    locations: ["src/main.ts:4:1"],
    messages: ["build failed"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-build-fail"),
    ".gitignore": gitignore,
    "rules.yaml": okRules,
    ...okScripts,
    "scripts/build.mjs": `console.log("vite v5.4.0 building for production...")
console.log("src/main.ts(4,1): error: Could not resolve \\"./App.vue\\" from src/main.ts")
console.log("error during build: Rollup failed to resolve import")
process.exit(1)
`,
    ...sources,
  },
)

// ---------------------------------------------------------------- 06 产物缺失

add(
  "06-artifact-missing",
  {
    kind: "gate",
    desc: "构建成功但产物不全：ARTIFACT_MISSING（dist/index.html 没生成）",
    exit: 1,
    codes: ["ARTIFACT_MISSING"],
    statuses: { typecheck: "pass", lint: "pass", test: "pass", build: "pass", artifacts: "fail" },
    messages: ["required artifact missing: dist/index.html"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-artifact-missing"),
    ".gitignore": gitignore,
    "rules.yaml": okRules,
    ...okScripts,
    "scripts/build.mjs": `import { mkdirSync, writeFileSync } from "node:fs"

// 只产出 js，忘了生成 html 入口
mkdirSync("dist/assets", { recursive: true })
writeFileSync("dist/assets/app.js", 'console.log("vite build output")\\n')
console.log("[build] 构建完成（缺少 index.html）")
`,
    ...sources,
  },
)

// ---------------------------------------------------------------- 07 规则错误：project_type 非法 → exit 2

add(
  "07-rules-bad-type",
  {
    kind: "gate",
    desc: "规则错误：project_type 不在枚举内 → 退出码 2（不是门禁失败，是配置错误）",
    exit: 2,
    codes: ["CONFIG_ERROR"],
    statuses: {},
    messages: ["project_type must be one of"],
  },
  {
    "package.json": pkg("wwk-fixture-rules-bad-type"),
    ".gitignore": gitignore,
    "rules.yaml": `version: 1
# 故意写错：合法值是 electron | web | uniapp | miniprogram
project_type: vue
profiles:
  web:
    checks: [typecheck]
    typecheck:
      run: node scripts/typecheck.mjs
`,
    ...okScripts,
    ...sources,
  },
)

// ---------------------------------------------------------------- 08 check 没写 run → exit 2

add(
  "08-check-no-run",
  {
    kind: "gate",
    desc: "规则错误：checks 里列了 build 却没写 run，也没有同名内置检查 → 退出码 2",
    exit: 2,
    codes: ["CONFIG_ERROR"],
    statuses: { typecheck: "pass" },
    messages: ['unknown check "build"'],
  },
  {
    "package.json": pkg("wwk-fixture-check-no-run"),
    ".gitignore": gitignore,
    "rules.yaml": `version: 1
project_type: web
defaults:
  timeout_sec: 120
profiles:
  web:
    checks: [typecheck, build]
    typecheck:
      run: node scripts/typecheck.mjs
    # build 忘了写 run：既不是命令检查，也不是内置检查
    build: {}
`,
    ...okScripts,
    ...sources,
  },
)

// ---------------------------------------------------------------- 09 检查内部崩溃 → exit 1

add(
  "09-check-crash",
  {
    kind: "gate",
    desc: "检查自身崩溃（app.json 不是合法 JSON）：失败码 CONFIG_ERROR 但退出码是 1",
    exit: 1,
    codes: ["CONFIG_ERROR"],
    statuses: { build: "pass", artifacts: "pass", package_size: "fail" },
    messages: ["check crashed"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-check-crash"),
    ".gitignore": gitignore,
    "rules.yaml": `version: 1
project_type: miniprogram
defaults:
  timeout_sec: 120
profiles:
  miniprogram:
    checks: [build, artifacts, package_size]
    build:
      run: node scripts/build.mjs
    artifacts:
      dir: dist/build/mp-weixin
      required: [app.json, app.js, project.config.json]
    package_size:
      dir: dist/build/mp-weixin
      main_max_kb: 2048
      total_max_kb: 20480
`,
    "scripts/build.mjs": `import { mkdirSync, writeFileSync } from "node:fs"

const dir = "dist/build/mp-weixin"
mkdirSync(dir, { recursive: true })
// 故意的：少了一个右括号，package_size 读 app.json 时会抛异常
writeFileSync(dir + "/app.json", '{ "pages": ["pages/index/index"], "subPackages": [ }')
writeFileSync(dir + "/app.js", 'App({})\\n')
writeFileSync(dir + "/project.config.json", '{ "appid": "touristappid", "projectname": "wwk-fixture" }')
console.log("[build] 小程序构建完成（app.json 内容有语法错误）")
`,
  },
)

// ---------------------------------------------------------------- 10 小程序主包超限

add(
  "10-miniprogram-main-too-large",
  {
    kind: "gate",
    desc: "小程序主包超限：PACKAGE_TOO_LARGE（子包已被排除，只报主包）",
    exit: 1,
    codes: ["PACKAGE_TOO_LARGE"],
    statuses: { build: "pass", artifacts: "pass", package_size: "fail" },
    messages: ["main package", "KB > 200KB"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-mp-main-large"),
    ".gitignore": gitignore,
    "rules.yaml": `version: 1
project_type: miniprogram
defaults:
  timeout_sec: 120
profiles:
  miniprogram:
    checks: [build, artifacts, package_size]
    build:
      run: node scripts/build.mjs
    artifacts:
      dir: dist/build/mp-weixin
      required: [app.json, app.js, project.config.json]
    package_size:
      dir: dist/build/mp-weixin
      main_max_kb: 200
      total_max_kb: 20480
`,
    "scripts/build.mjs": `import { mkdirSync, writeFileSync } from "node:fs"

const dir = "dist/build/mp-weixin"
mkdirSync(dir + "/assets", { recursive: true })
mkdirSync(dir + "/pkgA", { recursive: true })
writeFileSync(dir + "/app.json", JSON.stringify({
  pages: ["pages/index/index"],
  subPackages: [{ root: "pkgA", pages: ["pages/heavy/heavy"] }],
}, null, 2))
writeFileSync(dir + "/app.js", 'App({})\\n')
writeFileSync(dir + "/project.config.json", '{ "appid": "touristappid", "projectname": "wwk-fixture" }')
// 主包 300KB，超过 main_max_kb: 200
writeFileSync(dir + "/assets/main.bin", Buffer.alloc(300 * 1024, 7))
// 子包 120KB：不计入主包
writeFileSync(dir + "/pkgA/heavy.bin", Buffer.alloc(120 * 1024, 7))
console.log("[build] 小程序构建完成：主包约 300KB")
`,
  },
)

// ---------------------------------------------------------------- 11 子包不计入主包（全绿）

add(
  "11-miniprogram-subpackage-ok",
  {
    kind: "gate",
    desc: "小程序子包不计入主包：主包 50KB + 子包 2MB 仍全绿（证明 subPackages 被排除）",
    exit: 0,
    codes: [],
    statuses: { build: "pass", artifacts: "pass", package_size: "pass" },
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-mp-subpackage"),
    ".gitignore": gitignore,
    "rules.yaml": `version: 1
project_type: miniprogram
defaults:
  timeout_sec: 120
profiles:
  miniprogram:
    checks: [build, artifacts, package_size]
    build:
      run: node scripts/build.mjs
    artifacts:
      dir: dist/build/mp-weixin
      required: [app.json, app.js, project.config.json]
    package_size:
      dir: dist/build/mp-weixin
      main_max_kb: 100
      total_max_kb: 20480
`,
    "scripts/build.mjs": `import { mkdirSync, writeFileSync } from "node:fs"

const dir = "dist/build/mp-weixin"
mkdirSync(dir + "/assets", { recursive: true })
mkdirSync(dir + "/pkgA/pages/heavy", { recursive: true })
writeFileSync(dir + "/app.json", JSON.stringify({
  pages: ["pages/index/index"],
  subPackages: [{ root: "pkgA", pages: ["pages/heavy/heavy"] }],
}, null, 2))
writeFileSync(dir + "/app.js", 'App({})\\n')
writeFileSync(dir + "/project.config.json", '{ "appid": "touristappid", "projectname": "wwk-fixture" }')
// 主包只有 50KB
writeFileSync(dir + "/assets/main.bin", Buffer.alloc(50 * 1024, 7))
// 子包 2MB：若实现没排除子包，主包会变成 2MB 而超限
writeFileSync(dir + "/pkgA/pages/heavy/heavy.bin", Buffer.alloc(2048 * 1024, 7))
console.log("[build] 小程序构建完成：主包约 50KB，子包 2MB")
`,
  },
)

// ---------------------------------------------------------------- 12 electron 全链路（asar + 安装包）

const packAsar = `// 按 electron asar 的二进制格式写归档：8 字节 size pickle + header pickle + 文件体。
// 格式见 kit 的 verify/lib/asar.ts；这里用最小实现，供门禁的 unpacked 检查读取。
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function packAsar(entries, outPath) {
  const files = {}
  const bodies = []
  let offset = 0
  for (const e of entries) {
    files[e.name] = { size: e.data.length, offset }
    bodies.push(e.data)
    offset += e.data.length
  }
  const json = Buffer.from(JSON.stringify({ files }), "utf8")
  const pad = (4 - (json.length % 4)) % 4
  const jsonBuf = Buffer.concat([json, Buffer.alloc(pad, 0x20)])
  const payloadSize = jsonBuf.length + 4
  const headerSize = payloadSize + 4
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerSize, 4)
  const headerPickle = Buffer.alloc(8 + jsonBuf.length)
  headerPickle.writeUInt32LE(payloadSize, 0)
  headerPickle.writeUInt32LE(jsonBuf.length, 4)
  jsonBuf.copy(headerPickle, 8)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, Buffer.concat([sizePickle, headerPickle, ...bodies]))
}
`

const electronBuild = `import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { packAsar } from "./pack-asar.mjs"

// 用法：node scripts/build-electron.mjs [bad-asar]
const badAsar = process.argv.includes("bad-asar")
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const unpacked = "dist/win-unpacked"

mkdirSync(unpacked + "/resources", { recursive: true })
const appPkg = Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version, main: "app.js" }), "utf8")
const appJs = Buffer.from('console.log("electron fixture ready")\\n', "utf8")
const entries = badAsar
  ? [{ name: "app.js", data: appJs }] // 缺 package.json，且版本无从校验
  : [{ name: "package.json", data: appPkg }, { name: "app.js", data: appJs }]
packAsar(entries, unpacked + "/resources/app.asar")

// 安装包：文件名必须含版本号，latest.yml 的 version / sha512 必须对得上
const installerName = pkg.name + "-" + pkg.version + ".exe"
writeFileSync("dist/" + installerName, "fake-installer-bytes")
const body = readFileSync("dist/" + installerName)
const sha512 = createHash("sha512").update(body).digest("base64")
writeFileSync("dist/latest.yml", [
  "version: " + pkg.version,
  "files:",
  "  - url: " + installerName,
  '    sha512: "' + sha512 + '"',
  "    size: " + body.length,
  "path: " + installerName,
  'sha512: "' + sha512 + '"',
  "releaseDate: '2026-01-01T00:00:00.000Z'",
  "",
].join("\\n"))
console.log("[build] electronup build 完成" + (badAsar ? "（app.asar 故意缺 package.json）" : ""))
`

const electronRules = `version: 1
project_type: electron
defaults:
  timeout_sec: 120
  max_detail_chars: 3000
  fail_fast: false
commands:
  typecheck:
    run: node scripts/typecheck.mjs
  lint:
    run: node scripts/lint.mjs
  test:
    run: node scripts/test.mjs
profiles:
  electron:
    checks: [typecheck, lint, test, build, unpacked, installer]
    build:
      run: node scripts/build-electron.mjs
    unpacked:
      dir: dist/win-unpacked
      asar: resources/app.asar
      asar_required: [package.json]
      check_version: true
    installer:
      dir: dist
      pattern: "*.exe"
      latest_yml: latest.yml
`

add(
  "12-electron-pass",
  {
    kind: "gate",
    desc: "electron 全链路：app.asar 条目与版本正确、安装包名含版本、latest.yml 的 sha512 校验通过",
    exit: 0,
    codes: [],
    statuses: {
      typecheck: "pass",
      lint: "pass",
      test: "pass",
      build: "pass",
      unpacked: "pass",
      installer: "pass",
    },
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-electron-fixture"),
    ".gitignore": gitignore,
    "rules.yaml": electronRules,
    ...okScripts,
    "scripts/build-electron.mjs": electronBuild,
    "scripts/pack-asar.mjs": packAsar,
    ...sources,
  },
)

// ---------------------------------------------------------------- 13 electron 产物全缺

add(
  "13-electron-artifact-missing",
  {
    kind: "gate",
    desc: "electron 构建成功但没有产物：unpacked / installer / smoke 三个检查各自报 ARTIFACT_MISSING",
    exit: 1,
    codes: ["ARTIFACT_MISSING"],
    statuses: { build: "pass", unpacked: "fail", installer: "fail", smoke: "fail" },
    messages: ["unpacked dir missing", "no installer matches", "smoke exe missing"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-electron-fixture"),
    ".gitignore": gitignore,
    "rules.yaml": `version: 1
project_type: electron
defaults:
  timeout_sec: 120
profiles:
  electron:
    checks: [build, unpacked, installer, smoke]
    build:
      run: node scripts/build.mjs
    unpacked:
      dir: dist/win-unpacked
      asar: resources/app.asar
      asar_required: [package.json]
      check_version: true
    installer:
      dir: dist
      pattern: "*.exe"
      latest_yml: latest.yml
    smoke:
      exe: dist/win-unpacked/App.exe
      args: []
      alive_ms: 3000
`,
    "scripts/build.mjs": `// 构建“成功”但什么都没产出：验证下游产物检查各自独立报错
console.log("[build] 完成，但没有产出任何安装包")
`,
  },
)

// ---------------------------------------------------------------- 14 asar 内容错误

add(
  "14-electron-asar-bad",
  {
    kind: "gate",
    desc: "app.asar 缺 package.json 且版本对不上：ASAR_MISSING_ENTRY + VERSION_MISMATCH",
    exit: 1,
    codes: ["ASAR_MISSING_ENTRY", "VERSION_MISMATCH"],
    statuses: { build: "pass", unpacked: "fail", installer: "pass" },
    messages: ["app.asar lacks package.json", "app.asar package.json version <none> != project 1.0.0"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-electron-fixture"),
    ".gitignore": gitignore,
    "rules.yaml": electronRules.replace(
      "run: node scripts/build-electron.mjs",
      "run: node scripts/build-electron.mjs bad-asar",
    ),
    ...okScripts,
    "scripts/build-electron.mjs": electronBuild,
    "scripts/pack-asar.mjs": packAsar,
    ...sources,
  },
)

// ---------------------------------------------------------------- 15 fail_fast

add(
  "15-web-fail-fast",
  {
    kind: "gate",
    desc: "fail_fast: true：typecheck 失败后其余检查全部 skip（reason: fail_fast）",
    exit: 1,
    codes: ["TYPECHECK_FAIL"],
    statuses: { typecheck: "fail", lint: "skip", test: "skip", build: "skip", artifacts: "skip" },
    locations: ["src/api/login.ts:9:15"],
    messages: ["fail_fast"],
    reset: ["dist"],
  },
  {
    "package.json": pkg("wwk-fixture-fail-fast"),
    ".gitignore": gitignore,
    "rules.yaml": okRules.replace("fail_fast: false", "fail_fast: true"),
    ...okScripts,
    "scripts/typecheck.mjs": `console.log("src/api/login.ts(9,15): error TS2551: Property 'submmit' does not exist on type 'LoginForm'.")
process.exit(1)
`,
    "scripts/build.mjs": buildWebOk,
    ...sources,
  },
)

// ---------------------------------------------------------------- 16~18 修复回环

const loopRules = `version: 1
project_type: web
defaults:
  timeout_sec: 120
  max_detail_chars: 3000
  fail_fast: false
profiles:
  web:
    checks: [build, artifacts]
    build:
      # 每次构建都先清空 dist，再从 public 拷入口：缺 public/index.html 就构建失败
      run: node scripts/build.mjs
    artifacts:
      dir: dist
      required: [index.html]
`

const loopConfig = (maxRetries) =>
  JSON.stringify(
    {
      version: "0.2.0",
      project_root: ".",
      max_retries: maxRetries,
      state_dir: ".agent",
      verify: { timeout_sec: 300 },
      diff: { max_chars: 12000, context_lines: 3 },
      design: { enabled: false },
      review: { backend: "skip" },
      fix: {
        backend: "command",
        command: ["node", "scripts/fix.mjs", "{prompt}"],
        timeout_sec: 120,
      },
      notify: { dedup_hours: 24 },
      checkpoint: { enabled: false },
    },
    null,
    2,
  ) + "\n"

const loopBuild = `import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

// 干净构建：先删产物，再从 public/ 拷入口页
rmSync("dist", { recursive: true, force: true })
if (!existsSync("public/index.html")) {
  console.log("public/index.html(1,1): error: entry html is missing")
  console.log("error during build: missing entry html")
  process.exit(1)
}
mkdirSync("dist", { recursive: true })
copyFileSync("public/index.html", "dist/index.html")
writeFileSync("dist/assets.js", 'console.log("bundle")\\n')
console.log("[build] 构建完成")
`

const loopSources = {
  "src/main.ts": sources["src/main.ts"],
  "src/App.vue": sources["src/App.vue"],
  "src/views/LoginPage.vue": sources["src/views/LoginPage.vue"],
  "src/api/login.ts": sources["src/api/login.ts"],
  "public/index.html": `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>登录</title></head>
  <body><div id="app"></div></body>
</html>
`,
}

add(
  "16-fixloop-pass",
  {
    kind: "fixloop",
    desc: "修复回环一轮通过：门禁失败 → 审阅跳过 → 修复脚本补上入口页 → 复验通过 → delivered",
    status: "delivered",
    attempt: 1,
    reset: ["public/index.html", "dist", ".agent"],
  },
  {
    "package.json": pkg("wwk-fixture-fixloop-pass"),
    ".gitignore": gitignore,
    "rules.yaml": loopRules,
    "agent.config.json": loopConfig(2),
    "scripts/build.mjs": loopBuild,
    // 修复 agent：把缺失的入口页补上
    "scripts/fix.mjs": `import { mkdirSync, writeFileSync } from "node:fs"

mkdirSync("public", { recursive: true })
writeFileSync("public/index.html", [
  "<!doctype html>",
  '<html lang="zh-CN">',
  "  <head><meta charset=\\"utf-8\\" /><title>登录</title></head>",
  '  <body><div id="app"></div></body>',
  "</html>",
  "",
].join("\\n"))
console.log("[fix] 已补上缺失的 public/index.html")
`,
    ...loopSources,
  },
)

add(
  "17-fixloop-retry-limit",
  {
    kind: "fixloop",
    desc: "修复回环耗尽重试：修复脚本什么都不改，第 2 次门禁失败后熔断（RETRY_LIMIT）",
    status: "broken",
    break_reason: "RETRY_LIMIT",
    attempt: 2,
    reset: ["public/index.html", "dist", ".agent"],
  },
  {
    "package.json": pkg("wwk-fixture-fixloop-retry"),
    ".gitignore": gitignore,
    "rules.yaml": loopRules,
    "agent.config.json": loopConfig(1),
    "scripts/build.mjs": loopBuild,
    // 修复 agent：退出码 0 但没改任何文件，下一轮门禁照样失败
    "scripts/fix.mjs": `console.log("[fix] 看过失败项了，但这次没有改动文件")
`,
    ...loopSources,
    "public/index.html": undefined, // 占位，下面删除
  },
)

// 17 的 public/ 目录要“缺入口页”，所以去掉 16 里的 public/index.html
delete CASES[CASES.length - 1].files["public/index.html"]

add(
  "18-fixloop-config-error",
  {
    kind: "fixloop",
    desc: "门禁规则错误（退出码 2）：直接熔断 GATE_CONFIG_ERROR，不进审阅、不跑修复",
    status: "broken",
    break_reason: "GATE_CONFIG_ERROR",
    attempt: 1,
    reset: ["dist", ".agent"],
  },
  {
    "package.json": pkg("wwk-fixture-fixloop-config"),
    ".gitignore": gitignore,
    "rules.yaml": `version: 1
project_type: vue
profiles:
  web:
    checks: [build]
    build:
      run: node scripts/build.mjs
`,
    "agent.config.json": loopConfig(2),
    "scripts/build.mjs": loopBuild,
    "scripts/fix.mjs": `console.log("[fix] 不该被调用到")
`,
    "src/main.ts": sources["src/main.ts"],
  },
)

// ---------------------------------------------------------------- 需求原文（给 UI / 流水线用）

const requirements = {
  "requirements/01-login-page.md": `# 需求：手机号验证码登录页

在现有 Vue 3 项目里实现登录页：

- 手机号输入框（11 位数字，输入非法时提示"请输入正确的手机号"）
- 验证码输入框 + "获取验证码"按钮，点击后 60 秒倒计时，倒计时期间按钮禁用
- 提交按钮：调用 \`src/api/login.ts\` 里的 \`submitLogin\`
- 失败提示内联展示在表单下方，不弹 toast
- 设计稿：见 designs/login.json（主色 #2F6BFF，圆角 8px，间距 16px）
- 验收：\`pnpm exec vue-tsc --noEmit\`、\`pnpm exec eslint . --max-warnings=0\`、\`pnpm exec vitest run\` 全通过，\`dist/index.html\` 存在

**不要**修改 \`rules.yaml\` 和 \`agent.config.json\`。
`,
  "requirements/02-electron-release.md": `# 需求：补齐 electron 发布产物

当前 electron 项目 \`pnpm exec electronup build\` 能过，但门禁在 unpacked / installer 两项失败：

- \`dist/win-unpacked/resources/app.asar\` 里必须有 \`package.json\`，且其 version 与项目 \`package.json\` 一致
- \`dist/\` 下的安装包文件名必须包含版本号（如 \`wwk-electron-fixture-1.0.0.exe\`）
- \`dist/latest.yml\` 的 \`version\` 与 \`package.json\` 一致，\`files[].sha512\` 与安装包真实 sha512（base64）一致

验收以 \`node <kit>/web_workflow_kit/assets/verify.mjs --cwd . --json\` 退出码为准（0 通过）。
`,
}

// ---------------------------------------------------------------- 写盘

rmSync(OUT, { recursive: true, force: true })
let count = 0
for (const { name, expected, files } of CASES) {
  const dir = join(OUT, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    if (content == null) continue
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, "utf8")
    count++
  }
  writeFileSync(join(dir, "expected.json"), JSON.stringify(expected, null, 2) + "\n", "utf8")
  count++
}
for (const [rel, content] of Object.entries(requirements)) {
  const target = join(OUT, "..", rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, "utf8")
  count++
}
console.log(`已生成 ${CASES.length} 个场景、${count} 个文件 → ${OUT}`)
