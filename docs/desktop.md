# 桌面端

`desktop/` 是基于 [electronup-template](https://github.com/QuiteerJs/electronup-template) 的 Electron 应用，把本地控制台包成一个桌面程序：双击打开，不用开终端、不用记端口，**也不需要装 Python**。

## 工作方式

```
Electron 主进程 ──启动──→ Electron 自带的 Node 运行 resources/core/wwk.mjs ui --port 18765 --no-browser
      │                              │
      └── 窗口加载 http://127.0.0.1:18765/ ←┘（就是控制台页面）
```

- **后端是 TS 核心**：`core/` 打成单文件 `wwk.mjs`（依赖全部内联），用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE`）运行；流水线、门禁、agent 调用、工作空间都在里面，桌面端只负责启动、展示和收尾。
- **随应用分发的文件**：`resources/core/wwk.mjs` 和 `resources/assets/`（默认配置、提示词、门禁脚本 `verify.mjs`、控制台页面），后端经 `WWK_ASSETS` 找到后者。
- **不需要 Python**；门禁和 agent 仍要用到本机的命令（项目自己的 `pnpm` / `node`，以及 `claude`、`codex`、`dsh` 等），这些本来就是前端开发机上有的。本机没有 `node` 时，门禁会退回用 Electron 自带的 Node 跑 `verify.mjs`。
- **固定端口**：优先用 18765（被占用时依次试 18766–18769），页面存在 localStorage 里的主题、草稿才不会丢。
- **退出即停止**：退出时结束后端进程树，包括它拉起的门禁命令和编程 agent。Windows 关闭窗口即退出；macOS 按惯例关窗口后应用留在程序坞，`Cmd+Q` 才退出。
- **继承 shell 的 PATH**（macOS / Linux）：从访达、程序坞启动的应用只有系统默认 PATH，启动时会向登录 shell 要一次 PATH，这样才能找到 `node`、`pnpm` 和 `claude` / `codex` / `dsh` 等命令。

## 和浏览器版的区别

| | 浏览器版（`agent ui`） | 桌面端 |
| --- | --- | --- |
| 启动 | 终端里运行 `wwk ui`（或 Python 版的 `agent ui`） | 双击应用 |
| 选择项目目录 | 后端弹系统对话框（macOS 用 AppleScript，Windows 用 PowerShell，Linux 用 zenity） | Electron 原生对话框 |
| 外部链接 | 浏览器内打开 | 系统浏览器打开 |
| 后端异常退出 | 页面显示断开 | 回到启动页，显示最后的日志，可一键重试 |

控制台页面里只多了一处判断：检测到 `window.wwkDesktop` 时用原生对话框选目录和设计稿。preload 只暴露选择目录、选择文件、启动状态、重试、复制这几个固定能力，主进程只接受来自启动页和本机控制台页的请求。

## 开发

需要 Node ≥ 22.18（electronup 的要求）和 pnpm。`pnpm dev` 和各个打包命令会先运行 `pnpm core`：安装 `core/` 的依赖并打出 `core/dist/wwk.mjs`。

```bash
cd desktop
```

```bash
pnpm install
```

```bash
pnpm dev
```

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 渲染进程热更新，主进程改动后自动重启（改了 `core/` 要重新运行一次，后端用的是打好的 `wwk.mjs`） |
| `pnpm core` | 只重新打 TS 核心 `core/dist/wwk.mjs` |
| `pnpm build:dir` | 只生成免安装目录（Windows 是 `dist/out/win-unpacked`，macOS 是 `dist/out/mac-arm64`），用来快速检查打包结果 |
| `pnpm build:win` / `build:mac` / `build:linux` | 生成安装包（mac 只能在 macOS 上打，linux 不能在 Windows 上打） |
| `pnpm typecheck` / `pnpm lint` | 类型检查 / 代码风格 |

Electron 45 起安装时不再下载二进制：`pnpm install` 后 `node_modules/electron/dist` 不存在是正常的，第一次 `pnpm dev` 时会打印 `Downloading Electron binary...` 自动下载。这一步**不读** `desktop/.npmrc` 里的 `electron_mirror`，默认从 GitHub 下载，国内可能要几十分钟。用环境变量指定镜像：

```bash
export ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/
```

Windows PowerShell 里是 `$env:ELECTRON_MIRROR = '...'`。打安装包时 electron-builder 的工具同理可设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `main/index.ts` | 窗口、菜单、IPC、生命周期 |
| `main/env.ts` | TS 核心与 assets 的位置；继承登录 shell 的 PATH |
| `main/backend.ts` | 启动 / 停止控制台后端，解析地址，保留最近日志 |
| `preload/index.ts` | 暴露给页面的 `window.wwkDesktop` |
| `render/` | 启动页：启动进度，后端起不来或异常退出时显示日志、可重试 |
| `electronup.config.ts` | 构建与打包配置（`extraResources` 带上 `wwk.mjs` 与 assets） |

## 常见问题

**`pnpm dev` 构建完就结束，没有窗口也没有报错**

electronup 只转发 Electron 的输出，不打印退出码，所以 Electron 启动即崩溃时看起来像“正常结束”。在 Windows 上最常见的原因是仓库目录带了 **Low 完整性标签**：从这种目录里启动的 `electron.exe` 会以低完整性运行，Chromium 沙箱初始化失败直接崩溃（退出码 `0x80000003`）；即使加 `--no-sandbox`，也写不了 `%APPDATA%`，拿不到单实例锁而退出。一些编程 agent 的 Windows 沙箱会给允许写入的目录打上这个标签。

1. 看 `electron.exe` 有没有 Low 标签：

   ```bash
   icacls desktop\node_modules\electron\dist\electron.exe
   ```

   输出里有 `Mandatory Label\Low Mandatory Level` 就是这个问题。带 `(I)` 表示继承而来，再往上查是哪一级目录显式设置的（不带 `(I)` 的那一级）：

   ```bash
   icacls .
   ```

2. 把那一级目录改回 Medium（PowerShell 里括号要加引号；用自己的账户运行即可，不需要管理员）：

   ```bash
   icacls "D:\path\to\web-workflow-kit" /setintegritylevel "(OI)(CI)M"
   ```

   改完再执行第 1 步，确认 `Low Mandatory Level` 不见了。注意：如果标签是某个沙箱工具为了能写这个目录而加的，改回后它可能就写不了这里了。

3. 不想动权限，也可以把仓库另外克隆到一个没有该标签的目录里跑桌面端。

要确认是不是这个原因，可以直接看退出码：`0x80000003`（十进制 2147483651）基本就是它。

**首次 `pnpm install` 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`**

pnpm 12 默认不安装发布不到约一天的包。刚发布的依赖（如 electronup 新版本）过了这个时间就能正常安装；急用时本次安装可加 `--config.minimum-release-age=0`。`pnpm dev` 等脚本也会做同样的检查，这段时间里可以设环境变量 `pnpm_config_minimum_release_age=0`。

## 已知限制

- 还没有应用图标，用的是 Electron 默认图标。
- 安装包没有签名，Windows 首次运行可能出现 SmartScreen 提示；macOS 的 dmg 只有 ad-hoc 签名、没有公证，从网上下载后首次打开要在「系统设置 → 隐私与安全性」里点「仍要打开」。
- macOS 安装包只打了 arm64（Apple 芯片）。
- 切到 TS 核心后，macOS（Apple 芯片）实测过：`pnpm dev` 启动并加载控制台（进程树里没有 Python）、读回原来的工作空间和运行记录、退出后门禁命令无残留；dmg 打包后按访达的环境启动，跑通一次真实门禁（`pnpm` / `node` 经继承的 PATH 找到），退出后无残留。
- Windows 上的桌面端还没在 TS 核心上实测（TS 核心本身在 CI 的 Windows 上测试与 18 个场景都通过）。
- Linux 还没实测。
