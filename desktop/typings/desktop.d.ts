/** 启动页显示的后端状态，主进程推送给渲染进程 */
interface BootStatus {
  phase: 'starting' | 'error'
  message: string
  /** 出错时：每个候选解释器的失败原因 */
  failures?: { label: string, error: string }[]
  /** 出错时：后端输出的最后几行 */
  log?: string
}

/** preload 暴露给页面的接口（启动页和控制台页都有） */
interface WwkDesktop {
  platform: string
  /** 系统“选择文件夹”窗口，返回正斜杠路径，取消返回 null */
  pickFolder: (initial?: string | null) => Promise<string | null>
  getStatus: () => Promise<BootStatus>
  onStatus: (listener: (status: BootStatus) => void) => void
  retry: () => Promise<void>
  /** 选一个 python 可执行文件，记住它并重试 */
  choosePython: () => Promise<void>
  copy: (text: string) => Promise<void>
}

interface Window {
  wwkDesktop: WwkDesktop
}
