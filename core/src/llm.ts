// OpenAI 兼容的 Chat Completions 客户端（DeepSeek / GPT），只用内置 fetch。
export class LLMError extends Error {}

export async function chat(baseUrl: string, apiKey: string, model: string, system: string, user: string,
  opts: { jsonMode?: boolean, timeoutSec?: number } = {}): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0,
  }
  if (opts.jsonMode)
    body.response_format = { type: "json_object" }
  let res: Response
  try {
    res = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((opts.timeoutSec ?? 180) * 1000),
    })
  }
  catch (e) {
    throw new LLMError(String((e as Error).message ?? e))
  }
  if (!res.ok)
    throw new LLMError(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json() as any
  const choice = data.choices[0]
  if (choice.finish_reason === "length")
    throw new LLMError("response truncated (finish_reason=length)")
  return choice.message.content
}

export function parseJson(text: string): Record<string, any> {
  let t = text.trim()
  const m = /```(?:json)?\s*(\{.*\})\s*```/s.exec(t)
  if (m)
    t = m[1]
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start < 0 || end < start)
    throw new LLMError("no JSON object in response")
  return JSON.parse(t.slice(start, end + 1))
}

/** 从 i 处的 `{` 开始找到配对的 `}`（跳过字符串里的括号），返回结束下标；不完整返回 -1。 */
export function matchBrace(text: string, i: number): number {
  let depth = 0
  let inStr = false
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (inStr) {
      if (ch === "\\")
        j++
      else if (ch === "\"")
        inStr = false
    }
    else if (ch === "\"") {
      inStr = true
    }
    else if (ch === "{") {
      depth++
    }
    else if (ch === "}" && --depth === 0) {
      return j
    }
  }
  return -1
}
