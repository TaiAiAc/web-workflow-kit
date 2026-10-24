// 阶段提交的路径白名单（第二阶段）：每次阶段提交前，把暂存区里的路径按提交来源对一遍，越界即中止运行。
// agent 写文件时可能写到白名单外（权限应答拦不住所有写法），所以在提交这一步统一把关。
import { execFileSync } from "node:child_process"

/** 谁在提交：各文档阶段、写代码、门禁的修复回环、验收打回后的重做；门禁和验收本身不提交。 */
export type CommitSource = "discovery" | "tech-design" | "implement" | "gate-fix" | "acceptance-redo" | "gate" | "acceptance"
export type ReturnStage = "discovery" | "tech-design" | "implement"

export interface WhitelistOptions {
  /** 入库文档目录，即工作流配置的 documents.repo_dir */
  repoDir: string
  /** acceptance-redo 时：06 的 return_stage，按该阶段的白名单 */
  returnStage?: ReturnStage | null
}

export interface Violation {
  path: string
  reason: string
}

const CI_FILES = [".github/**", ".gitlab-ci.yml", ".circleci/**", ".buildkite/**", ".travis.yml", "azure-pipelines.yml", "Jenkinsfile"]
// 任何来源都不许提交
const NEVER = [".agent/**", ".env", ".env.*"]

interface Rule {
  /** null = 除 deny 外都允许（写代码）；数组 = 只允许这些 */
  allow: string[] | null
  deny: string[]
  label: string
}

function ruleFor(source: CommitSource, opts: WhitelistOptions): Rule {
  const r = opts.repoDir.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")
  switch (source) {
    case "discovery":
      return { allow: [`${r}/**/{01,02}-*.md`, `${r}/**/assets/*`], deny: [], label: "discovery 只能提交 01 / 02 文档和素材" }
    case "tech-design":
      return { allow: [`${r}/**/03-*.md`], deny: [], label: "tech-design 只能提交 03 文档" }
    case "implement":
    case "gate-fix":
      return {
        allow: null,
        deny: [`${r}/**`, "rules.yaml", "verify/**", "agent.config.json", ".gitignore", ...CI_FILES],
        label: `${source === "implement" ? "implement" : "门禁修复"} 只能提交代码（不能动文档、门禁规则、配置、.gitignore、CI）`,
      }
    case "acceptance-redo":
      if (!opts.returnStage)
        throw new Error("acceptance-redo 需要 return_stage")
      return ruleFor(opts.returnStage, opts)
    case "gate":
    case "acceptance":
      return { allow: [], deny: [], label: `${source} 本身不提交（报告只写 .agent/）` }
  }
}

/** 返回越界的路径；空数组 = 可以提交。路径用仓库相对路径（正斜杠）。 */
export function checkCommitPaths(source: CommitSource, paths: string[], opts: WhitelistOptions): Violation[] {
  const rule = ruleFor(source, opts)
  const out: Violation[] = []
  for (const raw of paths) {
    const path = raw.replaceAll("\\", "/").replace(/^\.\//, "")
    if (NEVER.some(g => matches(g, path)))
      out.push({ path, reason: "任何阶段都不能提交 .agent/ 和 .env" })
    else if (rule.deny.some(g => matches(g, path)) || (rule.allow && !rule.allow.some(g => matches(g, path))))
      out.push({ path, reason: rule.label })
  }
  return out
}

/** 暂存区里的路径；改名拆成删除 + 新增，两边都要过白名单。 */
export function stagedPaths(root: string): string[] {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], { cwd: root, encoding: "utf8" })
  return out.split("\0").filter(Boolean)
}

export class WhitelistError extends Error {
  readonly violations: Violation[]
  constructor(source: CommitSource, violations: Violation[]) {
    super(`${source} 的提交越界，运行中止：\n${violations.map(v => `- ${v.path}：${v.reason}`).join("\n")}`)
    this.name = "WhitelistError"
    this.violations = violations
  }
}

/** 提交前调用：暂存区有越界路径就抛 WhitelistError。 */
export function assertCommitAllowed(root: string, source: CommitSource, opts: WhitelistOptions): void {
  const violations = checkCommitPaths(source, stagedPaths(root), opts)
  if (violations.length)
    throw new WhitelistError(source, violations)
}

// ---------------- glob ----------------
// 只需要 ** / * / {a,b} 三种写法，不引依赖

const cache = new Map<string, RegExp>()

export function matches(glob: string, path: string): boolean {
  let re = cache.get(glob)
  if (!re) {
    let src = ""
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i]
      if (c === "*" && glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/"
        src += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
      }
      else if (c === "*") {
        src += "[^/]*"
      }
      else if (c === "{") {
        const end = glob.indexOf("}", i)
        src += `(?:${glob.slice(i + 1, end).split(",").map(escape).join("|")})`
        i = end
      }
      else {
        src += escape(c)
      }
    }
    re = new RegExp(`^${src}$`)
    cache.set(glob, re)
  }
  return re.test(path)
}

const escape = (s: string): string => s.replace(/[.+?^$()[\]|\\]/g, "\\$&")
