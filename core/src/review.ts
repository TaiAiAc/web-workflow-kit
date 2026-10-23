// 验收审阅（顾问）的后端：DeepSeek API / DeepSeek Harness / 跳过，默认自动选（与 Python 版 review.py 一致）。
//
// 顾问只出修复计划、无放行权，且必须只读：
// - api：直接调 HTTP 接口，天然改不了文件，并强制 JSON 输出；
// - dsh：`dsh headless` 是能改文件的 agent，所以审阅前后各取一次项目文件指纹，
//   有任何变化即判为违规（needs_human → 熔断），列出被改的文件交给人处理，不自动回滚；
// - skip：不审阅，修复者直接按门禁失败码和出错位置修。
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { type Config, prompt, relativeTo, writeText } from "./config.ts"
import { chat, LLMError, matchBracket, parseJson } from "./llm.ts"
import { run, which } from "./proc.ts"

export const BACKENDS: Record<string, string> = {
  auto: "自动",
  api: "DeepSeek API",
  dsh: "DeepSeek Harness",
  skip: "跳过审阅",
}

// 指纹不看这些目录：依赖、构建产物、流水线自己的产物
const SKIP_DIRS = new Set(["node_modules", ".git", ".agent", "dist", "build", "out", "coverage", ".cache",
  ".turbo", ".next", ".nuxt", ".output", ".vite", "unpackage"])

export type Plan = Record<string, any>

const apiKeyEnv = (cfg: Config): string => cfg.get("review").api_key_env ?? "DEEPSEEK_API_KEY"
const apiKey = (cfg: Config) => cfg.secret(apiKeyEnv(cfg))
const dshCommand = (cfg: Config): string[] => [...(cfg.get("review").dsh_command ?? ["dsh", "headless", "{prompt}"])]

/** 返回 [实际后端, 原因]。auto：有 key 用 API，否则装了 dsh 用 dsh，否则跳过。 */
export function resolveBackend(cfg: Config, choice?: string | null): [string, string] {
  const c = choice || cfg.get("review").backend || "auto"
  if (!(c in BACKENDS))
    throw new Error(`未知的审阅方式：${c}（可选：${Object.keys(BACKENDS).join(", ")}）`)
  if (c !== "auto")
    return [c, "手动指定"]
  if (apiKey(cfg))
    return ["api", `已配置 ${apiKeyEnv(cfg)}`]
  if (which(dshCommand(cfg)[0], cfg.childEnv()))
    return ["dsh", "未配置 API Key，本机有 dsh"]
  return ["skip", "未配置 API Key，本机也没有 dsh"]
}

/** 给控制台：每种审阅方式现在能不能用。 */
export function availability(cfg: Config): { key: string, label: string, available: boolean, detail: string }[] {
  const keyEnv = apiKeyEnv(cfg)
  const dsh = which(dshCommand(cfg)[0], cfg.childEnv())
  const [auto, why] = resolveBackend(cfg, "auto")
  const key = !!apiKey(cfg)
  return [
    { key: "auto", label: `自动（当前会用：${BACKENDS[auto]}）`, available: true, detail: why },
    { key: "api", label: BACKENDS.api, available: key, detail: key ? "只读、强制 JSON 输出" : `未配置 ${keyEnv}` },
    { key: "dsh", label: BACKENDS.dsh, available: !!dsh, detail: dsh ? "经 dsh headless；审阅前后校验没有改动文件" : "未找到 dsh 命令" },
    { key: "skip", label: BACKENDS.skip, available: true, detail: "修复者直接按门禁失败码修" },
  ]
}

export function fingerprint(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name))
          walk(p)
      }
      else {
        try {
          const st = statSync(p, { bigint: true })
          out.set(relativeTo(p, root), `${st.size}:${st.mtimeNs}`)
        }
        catch {}
      }
    }
  }
  walk(root)
  return out
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter(k => before.get(k) !== after.get(k)).sort()
}

/** agent 的输出里混着日志：从前往后找，取最后一个带 verdict 的 JSON 对象。 */
export function extractPlan(text: string): Plan {
  let found: Plan | null = null
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{")
      continue
    const end = matchBracket(text, i)
    if (end < 0)
      continue
    try {
      const obj = JSON.parse(text.slice(i, end + 1))
      if (obj && typeof obj === "object" && !Array.isArray(obj) && "verdict" in obj)
        found = obj
    }
    catch {}
  }
  if (!found)
    throw new LLMError("审阅输出里没有找到带 verdict 的 JSON")
  return found
}

// 顾问不可用不阻塞：修复者直接按失败码干活
const unavailable = (summary: string, backend: string): Plan =>
  ({ verdict: "unavailable", summary: summary.slice(0, 300), fixes: [], reviewer: backend })

export function makeReviewer(cfg: Config, choice: string | null | undefined, validate: (plan: unknown) => Plan) {
  const rcfg = cfg.get("review")
  const system = prompt("review-prompt.md")
  const timeoutSec = Number(rcfg.timeout_sec ?? 180)

  async function runDsh(payload: Record<string, unknown>, backend: string): Promise<Plan> {
    const cmd = dshCommand(cfg)
    const env = cfg.childEnv()
    const exe = which(cmd[0], env)
    if (!exe)
      return unavailable(`未找到 ${cmd[0]} 命令`, backend)
    const root = cfg.projectRoot
    const task = join(cfg.stateDir, "review-task.md")
    writeText(task, `${system}\n\n## 本次输入\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n`
      + "这是**只读**审阅：不要修改、创建或删除任何文件，不要运行会改动文件的命令。"
      + "只输出一个符合上面格式的 JSON 对象。\n")
    const short = `Read ${relativeTo(task, root)} and carry out the read-only review it describes. Do not modify any files. Output only the JSON object.`
    const before = fingerprint(root)
    const r = await run(exe, cmd.slice(1).map(a => a.replaceAll("{prompt}", short)), { cwd: root, env, timeoutMs: timeoutSec * 1000 })
    if (r.timedOut)
      return unavailable(`dsh 审阅超时（${timeoutSec}s）`, backend)
    const touched = changedFiles(before, fingerprint(root))
    if (touched.length) {
      const listed = touched.slice(0, 10).join("、") + (touched.length > 10 ? ` 等 ${touched.length} 个` : "")
      return { verdict: "needs_human", summary: `验收顾问（dsh）违规改动了文件：${listed}。请检查后再继续`, fixes: [], reviewer: backend, violation: touched }
    }
    if (r.code !== 0)
      return unavailable(`dsh 退出码 ${r.code}：${(r.stderr || r.stdout).slice(-300)}`, backend)
    try {
      return { ...validate(extractPlan(r.stdout)), reviewer: backend }
    }
    catch (e) {
      return unavailable(String((e as Error).message), backend)
    }
  }

  return async (payload: Record<string, unknown>): Promise<Plan> => {
    const [backend, why] = resolveBackend(cfg, choice)
    if (backend === "skip")
      return unavailable(`未审阅（${why}）`, backend)
    if (backend === "api") {
      const key = apiKey(cfg)
      if (!key)
        return unavailable(`${apiKeyEnv(cfg)} 未配置`, backend)
      try {
        // 无状态：每次只有 system + 本轮 payload，不带历史
        const text = await chat(rcfg.base_url, key, rcfg.model, system, JSON.stringify(payload), { jsonMode: true, timeoutSec })
        return { ...validate(parseJson(text)), reviewer: backend }
      }
      catch (e) {
        return unavailable(String((e as Error).message), backend)
      }
    }
    return runDsh(payload, backend)
  }
}
