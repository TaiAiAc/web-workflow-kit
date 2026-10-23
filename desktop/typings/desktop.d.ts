/** 启动页显示的后端状态，主进程推送给渲染进程 */
interface BootStatus {
  phase: 'starting' | 'error'
  message: string
  /** 出错时：后端输出的最后几行 */
  log?: string
}

/** preload 暴露给页面的接口（启动页和控制台页都有） */
interface WwkDesktop {
  platform: string
  /** 系统“选择文件夹”窗口，返回正斜杠路径，取消返回 null */
  pickFolder: (initial?: string | null) => Promise<string | null>
  /** 系统“选择文件”窗口（设计稿 .json），返回正斜杠路径，取消返回 null */
  pickFile: (initial?: string | null) => Promise<string | null>
  getStatus: () => Promise<BootStatus>
  onStatus: (listener: (status: BootStatus) => void) => void
  retry: () => Promise<void>
  copy: (text: string) => Promise<void>
}

interface Window {
  wwkDesktop: WwkDesktop
}
