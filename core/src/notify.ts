// 熔断邮件：同一错误码组合在去重窗口（默认 24 小时）内只发一次。
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import nodemailer from "nodemailer"
import { type Config, writeText } from "./config.ts"
import type { Failure } from "./gate.ts"

export function dedupKey(projectRoot: string, failures: Failure[], reason: string): string {
  const codes = [...new Set(failures.map(f => f.code ?? "?"))].sort()
  return createHash("sha1").update(`${projectRoot}|${(codes.length ? codes : [reason]).join(",")}`).digest("hex")
}

function loadCache(path: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  }
  catch {
    return {}
  }
}

export function shouldSend(cachePath: string, key: string, windowHours: number, now = Date.now() / 1000): boolean {
  const last = loadCache(cachePath)[key]
  return last === undefined || now - last >= windowHours * 3600
}

export function markSent(cachePath: string, key: string, windowHours: number, now = Date.now() / 1000): void {
  const cache = Object.fromEntries(Object.entries(loadCache(cachePath)).filter(([, v]) => now - v < windowHours * 3600))
  cache[key] = now
  writeText(cachePath, JSON.stringify(cache))
}

export function formatBody(state: Record<string, any>, cfg: Config): string {
  const lines = [
    `项目：${cfg.projectRoot}`,
    `需求：${state.requirement ?? ""}`,
    `熔断原因：${state.break_reason ?? ""}`,
    `门禁轮数：${state.attempt ?? 0}/${cfg.maxRetries}`,
    "",
    "失败项：",
  ]
  for (const f of (state.failures ?? []) as Failure[]) {
    lines.push(`- [${f.code}] ${f.message}`)
    lines.push(...(f.locations ?? []).slice(0, 5).map(loc => `    ${loc}`))
  }
  const plan = state.plan ?? {}
  if (plan.summary)
    lines.push("", `修复审阅结论：${plan.verdict} — ${plan.summary}`)
  lines.push("", `完整报告：${join(cfg.stateDir, "verify-report.json")}`, "需要人工介入：修复后在 REPL 里 :verify 重新过门禁。")
  return lines.join("\n")
}

/** 返回 sent / deduped / skipped(<原因>)，从不抛异常：通知失败不能掩盖熔断本身。 */
export async function notifyBreaker(state: Record<string, any>, cfg: Config): Promise<string> {
  const host = cfg.secret("SMTP_HOST")
  const to = cfg.secret("NOTIFY_EMAIL")
  if (!host || !to)
    return "skipped(SMTP_HOST/NOTIFY_EMAIL not set)"
  const windowHours = Number(cfg.get("notify").dedup_hours ?? 24)
  const cache = join(cfg.stateDir, ".notify_cache")
  const failures: Failure[] = state.failures ?? []
  const key = dedupKey(cfg.projectRoot, failures, state.break_reason ?? "")
  if (!shouldSend(cache, key, windowHours))
    return "deduped"

  const codes = [...new Set(failures.map(f => f.code ?? "?"))].sort().join(",") || state.break_reason || ""
  const port = Number(cfg.secret("SMTP_PORT") ?? 465)
  const user = cfg.secret("SMTP_USER")
  const pass = cfg.secret("SMTP_PASS")
  try {
    // 465 用 SSL，其他端口用 STARTTLS
    const transport = nodemailer.createTransport({
      host, port, secure: port === 465, requireTLS: port !== 465,
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: 30_000, socketTimeout: 30_000,
    })
    await transport.sendMail({
      from: user || to,
      to,
      subject: `[agent 熔断] ${basename(cfg.projectRoot)}: ${codes}`,
      text: formatBody(state, cfg),
    })
  }
  catch (e) {
    return `skipped(${(e as Error).name}: ${(e as Error).message})`
  }
  markSent(cache, key, windowHours)
  return "sent"
}
