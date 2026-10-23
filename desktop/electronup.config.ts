import { resolve } from 'node:path'
import { defineConfig } from 'electronup'

export default defineConfig({
  preload: {
    entry: { preload: resolve(__dirname, 'preload/index.ts') },
  },
  builderConfig: {
    appId: 'com.quiteer.web-workflow-kit',
    productName: '前端交付流水线',
    // 后端是 TS 核心的单文件产物，用 Electron 自带的 Node 跑（不需要用户装 Python）；
    // 默认配置、提示词、门禁脚本、控制台页面放在 resources/assets（WWK_ASSETS 指向它）
    extraResources: [
      { from: '../core/dist/wwk.mjs', to: 'core/wwk.mjs' },
      { from: '../assets', to: 'assets' },
    ],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
    },
    mac: {
      target: [{ target: 'dmg' }],
    },
  },
})
