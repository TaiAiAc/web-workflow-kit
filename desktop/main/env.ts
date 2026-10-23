import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { app } from 'electron'

const isWin = process.platform === 'win32'
const PATH_MARK = '__WWK_PATH__'

/** 仓库根目录（开发时）或 resources 目录（打包后） */
function root(): string {
  return app.isPackaged ? process.resourcesPath : resolve(__dirname, '../../..')
}

/** TS 核心的单文件产物（命令行 + 控制台）：打包后在 resources/core，开发时是仓库的 core/dist（pnpm core 生成） */
export function coreBundle(): string {
  return app.isPackaged ? join(root(), 'core', 'wwk.mjs') : join(root(), 'core', 'dist', 'wwk.mjs')
}

/** 默认配置、提示词、门禁脚本、控制台页面：打包后在 resources/assets，开发时直接用仓库里的 */
export function assetsDir(): string {
  return app.isPackaged ? join(root(), 'assets') : join(root(), 'assets')
}

/**
 * 从 Finder / Dock 启动的应用只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到门禁要的 node、pnpm
 * 和 claude / codex / dsh 等命令。启动时向登录 shell 要一次 PATH，放在前面。
 */
export function inheritShellPath(): void {
  if (isWin)
    return
  const shell = process.env.SHELL || '/bin/zsh'
  // -i 会加载 .zshrc，其中的输出可能混在前面，用标记把 PATH 摘出来
  const r = spawnSync(shell, ['-ilc', `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`], { encoding: 'utf-8', timeout: 5000 })
  const found = (r.stdout || '').split(PATH_MARK)[1]
  if (!found)
    return
  const merged = [...found.split(':'), ...(process.env.PATH || '').split(':')].filter(Boolean)
  process.env.PATH = [...new Set(merged)].join(':')
}
