// 浏览器版控制台用的系统对话框：浏览器拿不到所选目录的完整路径，所以由本地服务来弹。
// 桌面端走 Electron 的原生对话框（preload 的 pickFolder / pickFile），用不到这里。
import { spawn, spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import process from "node:process"

let picking: Promise<unknown> = Promise.resolve() // 同一时间只弹一个窗口

function serial<T>(fn: () => T): Promise<T> {
  const next = picking.then(fn, fn)
  picking = next.catch(() => {})
  return next
}

const start = (initial?: string | null) => (initial && existsSync(initial) && statSync(initial).isDirectory() ? initial : homedir())
const posix = (p: string) => p.replaceAll("\\", "/").replace(/(.)\/$/, "$1")

// AppleScript / PowerShell 字面量转义
const as = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
const ps = (s: string) => `'${s.replaceAll("'", "''")}'`

function dialog(kind: "folder" | "file", initial?: string | null): string | null {
  const dir = start(initial)
  let cmd: string
  let args: string[]
  if (process.platform === "darwin") {
    const what = kind === "folder"
      ? `choose folder with prompt "选择前端项目目录" default location POSIX file ${as(dir)}`
      : `choose file with prompt "选择设计稿" of type {"json", "public.json"} default location POSIX file ${as(dir)}`
    cmd = "osascript"
    args = ["-e", `POSIX path of (${what})`]
  }
  else if (process.platform === "win32") {
    const body = kind === "folder"
      ? `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择前端项目目录'; $d.SelectedPath = ${ps(dir)}; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`
      : `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '选择设计稿'; $d.Filter = '设计稿 JSON|*.json|所有文件|*.*'; $d.InitialDirectory = ${ps(dir)}; if ($d.ShowDialog() -eq 'OK') { $d.FileName }`
    cmd = "powershell"
    args = ["-NoProfile", "-STA", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ${body}`]
  }
  else {
    cmd = "zenity"
    args = kind === "folder"
      ? ["--file-selection", "--directory", "--title=选择前端项目目录", `--filename=${dir}/`]
      : ["--file-selection", "--title=选择设计稿", "--file-filter=*.json", `--filename=${dir}/`]
  }
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true })
  if (r.error)
    throw new Error(`本机没有可用的系统对话框（${cmd}），请手动输入路径`)
  const path = (r.stdout || "").trim()
  return r.status === 0 && path ? posix(path) : null // 取消：非 0 退出或空输出
}

/** 选择文件夹，返回正斜杠路径；取消返回 null。 */
export const pickFolder = (initial?: string | null) => serial(() => dialog("folder", initial))
/** 选择设计稿 .json；取消返回 null。 */
export const pickFile = (initial?: string | null) => serial(() => dialog("file", initial))

/** 用系统的文件管理器打开目录。 */
export function openFolder(path: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["explorer", [path]] : ["xdg-open", [path]]
  spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref()
}
