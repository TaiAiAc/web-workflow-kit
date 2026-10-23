import { resolve } from 'node:path'
import { defineConfig } from 'electronup'

export default defineConfig({
  preload: {
    entry: { preload: resolve(__dirname, 'preload/index.ts') },
  },
  builderConfig: {
    appId: 'com.quiteer.web-workflow-kit',
    productName: '前端交付流水线',
    // Python 后端随包分发：运行时以 resources/python 为 PYTHONPATH 启动 `web_workflow_kit.cli ui`
    extraResources: [
      {
        from: '../web_workflow_kit',
        to: 'python/web_workflow_kit',
        filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'],
      },
    ],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
    },
    mac: {
      target: [{ target: 'dmg' }],
    },
  },
})
