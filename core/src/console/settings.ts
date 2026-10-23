// 控制台「设置」：各 agent 的登录状态、发起登录，以及 API Key / 代理 / 邮件等环境变量。
// - 环境变量写进 .env：全局（~/.web-workflow-kit/.env）或某个工作空间的项目 .env（项目优先）；
//   流水线经 Config.childEnv() 把它们传给 claude / codex / dsh 等子进程，填了就对下一次运行生效。
// - 密钥只写不读：接口只返回“是否已设置”和末尾几位，页面上永远拿不到完整值。
// - 各 CLI 的 OAuth 登录都是交互式的，所以「登录」是在系统终端里打开对应命令（带上这里配的代理）。
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { connect as tlsConnect } from "node:tls"
import { parse as parseEnv } from "dotenv"
import { loadConfig, userHome } from "../config.ts"
import { run, which } from "../proc.ts"

export interface SettingItem {
  key: string
  group: "proxy" | "keys" | "mail"
  label: string
  secret?: boolean
  placeholder?: string
  hint?: string
  test?: string
}

// 页面上按组展示；secret 的只写不读
export const CATALOG: SettingItem[] = [
  { key: "HTTPS_PROXY", group: "proxy", label: "HTTPS 代理", placeholder: "http://127.0.0.1:7890", hint: "claude / codex / npx 访问外网用；国内网络连 Anthropic、OpenAI 通常需要" },
  { key: "HTTP_PROXY", group: "proxy", label: "HTTP 代理", placeholder: "http://127.0.0.1:7890" },
  { key: "NO_PROXY", group: "proxy", label: "不走代理", placeholder: "127.0.0.1,localhost", hint: "逗号分隔；本机地址务必保留" },
  { key: "DEEPSEEK_API_KEY", group: "keys", label: "DeepSeek API Key", secret: true, placeholder: "sk-…", hint: "DeepSeek Harness（dsh）写代码、修复、审阅都要；也用于「DeepSeek API」审阅", test: "deepseek" },
  { key: "ANTHROPIC_API_KEY", group: "keys", label: "Anthropic API Key", secret: true, placeholder: "sk-ant-…", hint: "可选：不想用 claude 账号登录时，Claude Code 改用 API Key 计费" },
  { key: "OPENAI_API_KEY", group: "keys", label: "OpenAI API Key", secret: true, placeholder: "sk-…", hint: "可选：Codex 用 API Key 而不是 ChatGPT 账号；Spec 改用 GPT 时也要" },
  { key: "CODEBUDDY_API_KEY", group: "keys", label: "CodeBuddy API Key", secret: true, hint: "WorkBuddy（CodeBuddy Code）非交互运行用；在 CodeBuddy 控制台创建" },
  { key: "SMTP_HOST", group: "mail", label: "SMTP 服务器", placeholder: "smtp.qq.com" },
  { key: "SMTP_PORT", group: "mail", label: "端口", placeholder: "465", hint: "465 用 SSL，其他端口用 STARTTLS" },
  { key: "SMTP_USER", group: "mail", label: "账号", placeholder: "you@example.com" },
  { key: "SMTP_PASS", group: "mail", label: "密码 / 授权码", secret: true },
  { key: "NOTIFY_EMAIL", group: "mail", label: "熔断通知收件人", placeholder: "team@example.com" },
]
const KEYS = new Map(CATALOG.map(c => [c.key, c]))

export function envFile(scope: string, project?: string | null): string {
  if (scope === "user")
    return join(userHome(), ".env")
  if (scope === "project" && project)
    return join(project, ".env")
  throw new Error(`未知的配置范围：${scope}`)
}

const mask = (v: string) => (v.length < 8 ? "已设置" : `${v.slice(0, 3)}…${v.slice(-4)}`)

function readEnv(path: string): Record<string, string> {
  try {
    return Object.fromEntries(Object.entries(parseEnv(readFileSync(path))).filter(([, v]) => v))
  }
  catch {
    return {}
  }
}

/** 每个变量在全局 / 项目里的值（密钥打码），以及实际生效的来源。 */
export function describeSettings(project?: string | null): Record<string, unknown> {
  const user = readEnv(envFile("user"))
  const proj = project ? readEnv(envFile("project", project)) : {}
  const items = CATALOG.map((c) => {
    const show = (v: string | undefined) => (v ? (c.secret ? mask(v) : v) : null)
    const sys = process.env[c.key]
    const source = c.key in proj ? "project" : c.key in user ? "user" : sys ? "system" : null
    return { ...c, user: show(user[c.key]), project: show(proj[c.key]), system: show(sys), source }
  })
  return {
    items,
    user_file: envFile("user").replaceAll("\\", "/"),
    system_proxy: systemProxy(),
    ...(project ? { project_file: envFile("project", project).replaceAll("\\", "/"), project_env_ignored: gitIgnored(project, ".env") } : {}),
  }
}

/** values：{KEY: 新值}；空串 / null = 删除这一项。只接受目录里的变量，文件里其余内容原样保留。 */
export function saveSettings(scope: string, project: string | null | undefined, values: Record<string, unknown>): void {
  const unknown = Object.keys(values).filter(k => !KEYS.has(k))
  if (unknown.length)
    throw new Error(`不支持的配置项：${unknown.join(", ")}`)
  const path = envFile(scope, project)
  mkdirSync(join(path, ".."), { recursive: true })
  let lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : []
  if (lines.at(-1) === "")
    lines.pop()
  for (const [k, raw] of Object.entries(values)) {
    const v = raw === null || raw === undefined ? "" : String(raw).trim()
    if (/[\r\n]/.test(v))
      throw new Error(`${k} 不能包含换行`)
    const at = lines.findIndex(l => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l))
    if (!v) {
      if (at >= 0)
        lines = lines.filter((_, i) => i !== at)
      continue
    }
    // 含空白、# 或引号的值加双引号，免得被 .env 解析成注释或截断
    const line = `${k}=${/[\s#"'\\]/.test(v) ? JSON.stringify(v) : v}`
    if (at >= 0)
      lines[at] = line
    else
      lines.push(line)
  }
  writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "", "utf8")
  try {
    chmodSync(path, 0o600) // 存了密钥：只给自己读写（Windows 上无效但无害）
  }
  catch {}
}

function gitIgnored(root: string, rel: string): boolean | null {
  if (!existsSync(join(root, ".git")))
    return null
  const r = spawnSync("git", ["check-ignore", "-q", rel], { cwd: root, windowsHide: true })
  return r.error ? null : r.status === 0
}

/** 系统设置里的代理（macOS 读 scutil，Windows 读注册表，其他看环境变量），页面上一键填入用。 */
export function systemProxy(): string | null {
  try {
    if (process.platform === "darwin") {
      const out = spawnSync("scutil", ["--proxy"], { encoding: "utf8" }).stdout ?? ""
      const get = (k: string) => new RegExp(`${k}\\s*:\\s*(\\S+)`).exec(out)?.[1]
      for (const p of ["HTTPS", "HTTP"]) {
        if (get(`${p}Enable`) === "1" && get(`${p}Proxy`))
          return `http://${get(`${p}Proxy`)}:${get(`${p}Port`) ?? 80}`
      }
      return null
    }
    if (process.platform === "win32") {
      const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
      const q = (v: string) => spawnSync("reg", ["query", key, "/v", v], { encoding: "utf8", windowsHide: true }).stdout ?? ""
      if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(q("ProxyEnable")))
        return null
      const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(q("ProxyServer"))?.[1]
      if (!server)
        return null
      const https = /https=([^;]+)/.exec(server)?.[1] ?? server.replace(/^http=/, "").split(";")[0]
      return https.includes("://") ? https : `http://${https}`
    }
  }
  catch {}
  return process.env.HTTPS_PROXY || process.env.https_proxy || null
}

// ---------------- agent 登录状态 ----------------

interface AgentSpec {
  key: string
  label: string
  cmd: string
  install: string | null
  login: string[] | null
  note: string
}

export const AGENTS: AgentSpec[] = [
  { key: "claude", label: "Claude Code", cmd: "claude", install: "npm install -g @anthropic-ai/claude-code", login: ["claude", "auth", "login"], note: "生成 Spec 固定用它；国内网络需要先在下面配好代理" },
  { key: "codex", label: "Codex", cmd: "codex", install: "npm install -g @openai/codex @agentclientprotocol/codex-acp@1.13.0", login: ["codex", "login"], note: "ChatGPT 账号登录，或在 ~/.codex/config.toml 配自定义模型服务，或填 OpenAI API Key" },
  { key: "opencode", label: "OpenCode", cmd: "opencode", install: "npm install -g opencode-ai", login: ["opencode", "auth", "login"], note: "登录时选择模型服务商并填它的 Key" },
  { key: "workbuddy", label: "WorkBuddy（CodeBuddy）", cmd: "codebuddy", install: "npm install -g @tencent-ai/codebuddy-code", login: ["codebuddy"], note: "首次打开会出现登录菜单；或直接填 CodeBuddy API Key" },
  { key: "dsh", label: "DeepSeek Harness", cmd: "dsh", install: null, login: null, note: "没有登录步骤，填 DeepSeek API Key 即可" },
]

async function cli(cmd: string[], env: NodeJS.ProcessEnv, timeoutSec = 15): Promise<{ code: number | null, out: string }> {
  const exe = which(cmd[0], env)
  if (!exe)
    return { code: null, out: "" }
  const r = await run(exe, cmd.slice(1), { cwd: homedir(), env, timeoutMs: timeoutSec * 1000 })
  return { code: r.timedOut ? -1 : r.code, out: `${r.stdout}${r.stderr}`.trim() }
}

function codexCustomProvider(): boolean {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml")
    return readFileSync(file, "utf8").split(/\r?\n/).some(l => l.trim().startsWith("model_provider"))
  }
  catch {
    return false
  }
}

async function agentStatus(a: AgentSpec, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const base = { key: a.key, label: a.label, install: a.install, note: a.note, can_login: !!a.login }
  if (!which(a.cmd, env))
    return { ...base, installed: false, state: "missing", detail: `未找到 ${a.cmd} 命令` }
  const v = await cli([a.cmd, "--version"], env, 10)
  const ok = (detail: string) => ({ ...base, installed: true, version: v.code === 0 ? v.out.split("\n")[0].slice(0, 60) : null, state: "ok", detail })
  const not = (state: string, detail: string) => ({ ...base, installed: true, version: v.code === 0 ? v.out.split("\n")[0].slice(0, 60) : null, state, detail })
  if (a.key === "claude") {
    const { out } = await cli(["claude", "auth", "status"], env)
    let data: Record<string, any> = {}
    try {
      data = out.includes("{") ? JSON.parse(out.slice(out.indexOf("{"))) : {}
    }
    catch {}
    if (data.loggedIn) {
      const who = data.email || data.subscriptionType || data.authMethod
      return ok(who ? `已登录（${who}）` : "已登录")
    }
    return env.ANTHROPIC_API_KEY ? ok("使用 Anthropic API Key") : not("login", "未登录")
  }
  if (a.key === "codex") {
    const { code, out } = await cli(["codex", "login", "status"], env)
    if (code === 0 && !/not logged in/i.test(out))
      return ok(out.split("\n")[0].slice(0, 80) || "已登录")
    if (env.OPENAI_API_KEY)
      return ok("使用 OpenAI API Key")
    return codexCustomProvider() ? ok("使用 ~/.codex/config.toml 里的自定义模型服务") : not("login", "未登录")
  }
  if (a.key === "opencode") {
    const { out } = await cli(["opencode", "auth", "list"], env)
    const n = Number(/(\d+)\s+credentials?/.exec(out)?.[1] ?? 0)
    return n ? ok(`已配置 ${n} 个模型服务商`) : not("login", "还没有配置模型服务商")
  }
  if (a.key === "workbuddy") {
    return env.CODEBUDDY_API_KEY || env.CODEBUDDY_AUTH_TOKEN
      ? ok("使用 CodeBuddy API Key")
      : not("unknown", "无法自动检测登录状态：在终端登录过一次即可，或填 API Key")
  }
  return env.DEEPSEEK_API_KEY ? ok("已配置 DeepSeek API Key") : not("key", "缺少 DeepSeek API Key")
}

export async function agentStatuses(project?: string | null): Promise<Record<string, unknown>[]> {
  const env = loadConfig(project ?? undefined).childEnv()
  return Promise.all(AGENTS.map(a => agentStatus(a, env)))
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`)

/** 在系统终端里打开登录命令。返回打开的命令行（展示给用户）。 */
export function launchLogin(agentKey: string, project: string | null | undefined, opener: (line: string) => void = openTerminal): string {
  const a = AGENTS.find(x => x.key === agentKey)
  if (!a)
    throw new Error(`未知的 agent：${agentKey}`)
  if (!a.login)
    throw new Error(`${a.label} 没有登录步骤，填 API Key 即可`)
  const env = loadConfig(project ?? undefined).childEnv()
  if (!which(a.cmd, env))
    throw new Error(`未找到 ${a.cmd} 命令，请先安装`)
  const proxy = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"].filter(k => env[k]).map(k => [k, env[k]!] as const)
  const line = process.platform === "win32"
    ? [...proxy.map(([k, v]) => `set ${k}=${v}&&`), ...a.login].join(" ")
    : [...proxy.map(([k, v]) => `export ${k}=${shq(v)};`), ...a.login.map(shq)].join(" ")
  opener(line)
  return line
}

/** 在新的系统终端窗口里执行一行命令，窗口留着给用户交互。 */
export function openTerminal(line: string): void {
  const detach = { detached: true, stdio: "ignore" as const, windowsHide: false }
  if (process.platform === "darwin") {
    spawn("osascript", ["-e", `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(line)}\nend tell`], detach).unref()
  }
  else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", "cmd", "/k", line], detach).unref()
  }
  else {
    const term = ["x-terminal-emulator", "gnome-terminal", "konsole"].map(t => which(t)).find(Boolean)
    if (!term)
      throw new Error(`没找到终端程序，请在终端里手动运行：${line}`)
    const sh = join(tmpdir(), `wwk-login-${Date.now()}.sh`)
    writeFileSync(sh, `${line}\nexec $SHELL\n`)
    spawn(term, ["-e", "sh", sh], detach).unref()
  }
}

// ---------------- 连通性 / 密钥测试 ----------------

export const NETWORK_TARGETS: [string, string][] = [
  ["Anthropic（Claude Code）", "https://api.anthropic.com/"],
  ["OpenAI（Codex）", "https://api.openai.com/"],
  ["DeepSeek", "https://api.deepseek.com/"],
  ["npm 仓库", "https://registry.npmjs.org/"],
]

export interface ProbeResult {
  ok: boolean
  status: number | null
  ms: number
  error: string | null
}

/**
 * 发一个 HTTPS GET 看能不能拿到响应。Node 的 fetch 不走代理，所以有代理时自己经 CONNECT 建隧道。
 * 能拿到 HTTP 响应就说明网络通了；403 多半是地区限制。
 */
export function probe(url: string, proxy: string | undefined, headers: Record<string, string> = {}, timeoutMs = 6000): Promise<ProbeResult> {
  const start = Date.now()
  const target = new URL(url)
  const port = Number(target.port || 443)
  return new Promise((resolve) => {
    let done = false
    const finish = (r: Omit<ProbeResult, "ms">) => {
      if (!done) {
        done = true
        resolve({ ...r, ms: Date.now() - start })
      }
    }
    const timer = setTimeout(() => finish({ ok: false, status: null, error: `${timeoutMs / 1000} 秒内没有响应` }), timeoutMs)
    const fail = (e: Error) => {
      clearTimeout(timer)
      finish({ ok: false, status: null, error: e.message.slice(0, 160) })
    }
    const overTls = (socket?: import("node:net").Socket) => {
      const tls = tlsConnect({ host: target.hostname, port, servername: target.hostname, ...(socket ? { socket } : {}) })
      tls.on("error", fail)
      tls.on("secureConnect", () => {
        const head = Object.entries({ "User-Agent": "web-workflow-kit", ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join("")
        tls.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\n${head}Connection: close\r\n\r\n`)
      })
      let first = ""
      tls.on("data", (d: Buffer) => {
        first += d.toString("latin1")
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(first)
        if (m) {
          clearTimeout(timer)
          const status = Number(m[1])
          finish({ ok: status !== 403, status, error: status === 403 ? "403：被拒绝，多半需要代理" : null })
          tls.destroy()
        }
      })
    }
    if (!proxy)
      return overTls()
    const p = new URL(proxy.includes("://") ? proxy : `http://${proxy}`)
    const req = httpRequest({ host: p.hostname, port: Number(p.port || 80), method: "CONNECT", path: `${target.hostname}:${port}` })
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200)
        return fail(new Error(`代理拒绝了隧道（HTTP ${res.statusCode}）`))
      overTls(socket)
    })
    req.on("error", e => fail(new Error(`连不上代理 ${p.host}：${e.message}`)))
    req.end()
  })
}

const proxyFor = (env: NodeJS.ProcessEnv, host: string) => {
  const skip = (env.NO_PROXY || env.no_proxy || "").split(",").map(s => s.trim()).filter(Boolean)
  return skip.some(s => host === s || host.endsWith(s.startsWith(".") ? s : `.${s}`)) ? undefined : env.HTTPS_PROXY || env.https_proxy
}

export async function testNetwork(project?: string | null): Promise<Record<string, unknown>[]> {
  const env = loadConfig(project ?? undefined).childEnv()
  return Promise.all(NETWORK_TARGETS.map(async ([name, url]) => ({ name, url, ...await probe(url, proxyFor(env, new URL(url).hostname)) })))
}

export async function testDeepseek(project?: string | null, url = "https://api.deepseek.com/models"): Promise<{ ok: boolean, detail: string }> {
  const env = loadConfig(project ?? undefined).childEnv()
  const key = env.DEEPSEEK_API_KEY
  if (!key)
    return { ok: false, detail: "还没有填 DeepSeek API Key" }
  const r = await probe(url, proxyFor(env, new URL(url).hostname), { Authorization: `Bearer ${key}` })
  if (r.status === 200)
    return { ok: true, detail: `Key 有效（${r.ms} ms）` }
  if (r.status === 401)
    return { ok: false, detail: "Key 无效（401）" }
  return { ok: false, detail: r.error || `请求失败（HTTP ${r.status}）` }
}
