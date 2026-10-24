import { resolve } from 'node:path'
import { defineConfig } from 'electronup'

export default defineConfig({
  preload: {
    entry: { preload: resolve(__dirname, 'preload/index.ts') },
  },
  builderConfig: {
    appId: 'com.quiteer.web-workflow-kit',
    productName: '前端交付流水线',
    // 后端是 TS 核心的产物 core/dist（wwk.mjs + assets/），用 Electron 自带的 Node 跑
    extraResources: [{ from: '../core/dist', to: 'core' }],
    // 图标源文件在 assets/brand/，resources/ 里是由它渲染出的各平台格式
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'resources/icon.ico',
    },
    mac: {
      target: [{ target: 'dmg' }],
      icon: 'resources/icon.icns',
    },
    linux: {
      icon: 'resources/icon.png',
    },
  },
})
