import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { Backend } from './backend'
import { findPython, inheritShellPath, probe, saveSettings } from './python'

const isDev = process.env.NODE_ENV === 'development'
const BOOT_URL = isDev
  ? `http://localhost:${process.env.RENDER_PORT}`
  : pathToFileURL(resolve(__dirname, 'index.html')).href // 要和 senderFrame.url 的写法一致，才能做来源校验
const PRELOAD = join(__dirname, 'preload.cjs')
const WEB_URL = /^https?:\/\//
const BACKSLASH = /\\/g

const backend = new Backend()
let win: BrowserWindow | null = null
let status: BootStatus = { phase: 'starting', message: '正在启动…' }
let booting = false

function setStatus(next: BootStatus): void {
  status = next
  win?.webContents.send('wwk:status', status)
}

function showBootPage(): void {
  if (win && !win.webContents.getURL().startsWith(BOOT_URL))
    void win.loadURL(BOOT_URL)
}

/** 找 Python → 起后端 → 窗口切到控制台；任何一步失败都停在启动页上显示原因 */
async function boot(): Promise<void> {
  if (booting)
    return
  booting = true
  try {
    showBootPage()
    setStatus({ phase: 'starting', message: '正在查找 Python…' })
    const { python, failures } = await findPython(py => setStatus({ phase: 'starting', message: `正在检查 ${py.label}…` }))
    if (!python) {
      setStatus({ phase: 'error', message: '没有找到可以运行流水线的 Python', failures })
      return
    }
    setStatus({ phase: 'starting', message: `正在启动本地服务（${python.label}）…` })
    try {
      const url = await backend.start(python)
      await win?.loadURL(url)
    }
    catch (e) {
      setStatus({ phase: 'error', message: (e as Error).message, log: backend.tail() })
    }
  }
  finally {
    booting = false
  }
}

backend.onExit = (code) => {
  showBootPage()
  setStatus({ phase: 'error', message: `本地服务意外退出（退出码 ${code}）`, log: backend.tail() })
}

// ---------- IPC：只接受启动页和本机控制台页发来的请求 ----------

function trusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return url.startsWith(BOOT_URL) || (!!backend.url && url.startsWith(backend.url))
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e))
      throw new Error('拒绝来自未知页面的请求')
    return fn(...args)
  })
}

handle('wwk:status', () => status)
handle('wwk:retry', () => boot())
handle('wwk:copy', (text: string) => clipboard.writeText(String(text)))

handle('wwk:pick-folder', async (initial: string | null) => {
  const r = await dialog.showOpenDialog(win!, {
    title: '选择前端项目目录',
    defaultPath: initial || app.getPath('home'),
    properties: ['openDirectory'],
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0].replace(BACKSLASH, '/')
})

handle('wwk:pick-file', async (initial: string | null) => {
  const r = await dialog.showOpenDialog(win!, {
    title: '选择设计稿',
    defaultPath: initial || app.getPath('home'),
    properties: ['openFile'],
    filters: [{ name: '设计稿 JSON', extensions: ['json'] }],
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0].replace(BACKSLASH, '/')
})

handle('wwk:choose-python', async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: '选择 Python 解释器（已安装 web-workflow-kit 依赖的那个）',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Python', extensions: ['exe'] }] : [],
  })
  const path = r.filePaths[0]
  if (r.canceled || !path)
    return
  const error = await probe({ command: path, args: [], label: path })
  if (error) {
    setStatus({ phase: 'error', message: '所选解释器不能运行流水线', failures: [{ label: path, error }] })
    return
  }
  saveSettings({ pythonPath: path })
  await boot()
})

// ---------- 窗口 ----------

function isAppUrl(url: string): boolean {
  return url.startsWith(BOOT_URL) || (!!backend.url && url.startsWith(backend.url))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: '前端交付流水线',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  // 外部链接交给系统浏览器，窗口里只留启动页和控制台
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (WEB_URL.test(url) && !isAppUrl(url))
      void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault()
      if (WEB_URL.test(url))
        void shell.openExternal(url)
    }
  })
  win.on('closed', () => (win = null))
  void boot()
}

function buildMenu(): void {
  // macOS 把第一个菜单当作应用名菜单，不先放一个的话「文件」会被吞掉
  const appMenu: MenuItemConstructorOptions[] = process.platform === 'darwin' ? [{ role: 'appMenu' }] : []
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenu,
    {
      label: '文件',
      submenu: [
        { label: '重启本地服务', click: () => void backend.stop().then(boot) },
        {
          label: '在浏览器中打开控制台',
          click: () => backend.url && void shell.openExternal(backend.url),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用说明',
          click: () => void shell.openExternal('https://github.com/TaiAiAc/web-workflow-kit#readme'),
        },
      ],
    },
  ]))
}

// ---------- 生命周期 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
}
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized())
        win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    inheritShellPath()
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length)
        createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
      app.quit()
  })

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting)
      return
    quitting = true
    e.preventDefault()
    void backend.stop().finally(() => app.quit())
  })
}
