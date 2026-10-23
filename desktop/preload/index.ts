import process from 'node:process'
import { contextBridge, ipcRenderer } from 'electron'

// 只暴露几个固定能力，不暴露通用 ipc：控制台页面来自本机 HTTP 服务，暴露面越小越好
const api: WwkDesktop = {
  platform: process.platform,
  pickFolder: initial => ipcRenderer.invoke('wwk:pick-folder', initial ?? null),
  getStatus: () => ipcRenderer.invoke('wwk:status'),
  onStatus: (listener) => {
    ipcRenderer.on('wwk:status', (_e, status: BootStatus) => listener(status))
  },
  retry: () => ipcRenderer.invoke('wwk:retry'),
  choosePython: () => ipcRenderer.invoke('wwk:choose-python'),
  copy: text => ipcRenderer.invoke('wwk:copy', text),
}

contextBridge.exposeInMainWorld('wwkDesktop', api)
