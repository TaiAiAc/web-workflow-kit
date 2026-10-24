// 只取本次改动块，不传整文件。
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Failure } from "./gate.ts"

export interface Hunk {
  file: string
  header: string
  patch: string
}

export interface Baseline {
  rev: string
  untracked: string[]
}

const HUNK = /^@@ .+? @@.*$/gm

function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : ""
}

const lines = (s: string) => s.split(/\r?\n/).filter(Boolean)

/** 编码前的基线：`git stash create` 生成工作区快照提交而不改动工作区；干净时退回 HEAD。 */
export function snapshot(root: string): Baseline {
  const rev = git(root, "stash", "create").trim() || git(root, "rev-parse", "HEAD").trim()
  return { rev, untracked: lines(git(root, "ls-files", "--others", "--exclude-standard")) }
}

export function splitHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/m.exec(block)
    let file = m ? m[1].trim() : block.split(/\s/)[0].replace(/^a\//, "")
    if (file === "/dev/null")
      file = block.split(/\s/)[0].replace(/^a\//, "")
    const starts = [...block.matchAll(HUNK)].map(x => x.index!)
    starts.forEach((s, i) => {
      const body = block.slice(s, starts[i + 1] ?? block.length)
      const nl = body.indexOf("\n")
      const header = nl < 0 ? body : body.slice(0, nl)
      const patch = nl < 0 ? "" : body.slice(nl + 1).replace(/\n+$/, "")
      hunks.push({ file, header, patch })
    })
  }
  return hunks
}

export function changedHunks(root: string, baseline: Baseline | null | undefined, failures: Failure[],
  maxChars = 12000, context = 3): Hunk[] {
  const rev = baseline?.rev || "HEAD"
  const hunks = splitHunks(git(root, "diff", `--unified=${context}`, rev, "--"))

  const before = new Set(baseline?.untracked ?? [])
  for (const rel of lines(git(root, "ls-files", "--others", "--exclude-standard"))) {
    if (before.has(rel))
      continue
    let text: string
    try {
      text = readFileSync(join(root, rel), "utf8")
    }
    catch {
      continue
    }
    if (text.includes("�"))
      continue // 非 UTF-8（二进制）文件
    const ls = text.split(/\r?\n/)
    if (ls.at(-1) === "")
      ls.pop()
    hunks.push({ file: rel, header: `@@ -0,0 +1,${ls.length} @@ (new file)`, patch: ls.map(l => "+" + l).join("\n") })
  }

  // 失败项点名的文件优先，超出预算的块直接丢弃
  const hot = new Set(failures.flatMap(f => (f.locations ?? []).map(loc => loc.split(":")[0])))
  const isHot = (h: Hunk) => [...hot].some(x => h.file.endsWith(x) || x.endsWith(h.file))
  hunks.sort((a, b) => Number(!isHot(a)) - Number(!isHot(b)) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const out: Hunk[] = []
  let used = 0
  for (const h of hunks) {
    const size = h.patch.length + h.header.length + h.file.length
    if (used + size > maxChars) {
      if (!out.length)
        out.push({ ...h, patch: h.patch.slice(0, maxChars) + "\n…(truncated)" })
      continue
    }
    out.push(h)
    used += size
  }
  return out
}
