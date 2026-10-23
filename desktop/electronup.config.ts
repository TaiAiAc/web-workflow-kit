import { resolve } from 'node:path'
import { defineConfig } from 'electronup'

export default defineConfig({
  preload: {
    entry: { preload: resolve(__dirname, 'preload/index.ts') },
  },
  builderConfig: {
    appId: 'com.quiteer.web-workflow-kit',
    productName: '前端交付流水线',
    // 后端是 TS 核心的产物 core/dist（wwk.mjs + assets/），用 Electron 自带的 Node 跑，不需要用户装 Python
    extraResources: [{ from: '../core/dist', to: 'core' }],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
    },
    mac: {
      target: [{ target: 'dmg' }],
    },
  },
})
