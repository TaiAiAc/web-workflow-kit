# 桌面端

`desktop/` 是基于 [electronup-template](https://github.com/QuiteerJs/electronup-template) 的 Electron 应用，把本地控制台（`agent ui`）包成一个桌面程序：双击打开，不用开终端、不用记端口。

## 工作方式

```
Electron 主进程 ──启动──→ python -m web_workflow_kit.cli ui --port 18765 --no-browser
      │                              │
      └── 窗口加载 http://127.0.0.1:18765/ ←┘（就是原来的控制台页面）
```

- **后端仍是 Python**：流水线、门禁、agent 调用全部沿用 `web_workflow_kit`，桌面端只负责启动、展示和收尾。
- **Python 源码随应用分发**：打包时把 `web_workflow_kit/` 复制到 `resources/python/`，运行时用它作 `PYTHONPATH`，所以桌面端的版本总是和应用一致，不依赖 pip 装的是哪个版本。
- **依赖要求**：需要一个装好 `langgraph`、`python-dotenv` 等依赖的 Python ≥ 3.10。按 README 装好 `web-workflow-kit[all]` 的虚拟环境即可。
- **固定端口**：优先用 18765（被占用时依次试 18766–18769），页面存在 localStorage 里的主题、草稿、最近项目才不会丢。
- **关闭窗口即停止**：退出时结束后端进程树，包括它拉起的门禁命令和编程 agent。

## 查找 Python 的顺序

1. 启动页上「选择 Python…」选过的解释器（存在用户数据目录的 `settings.json`）
2. 环境变量 `WWK_PYTHON`
3. `~/wwk-venv`（README 推荐的安装位置）
4. 仓库根目录的 `.venv`（仅开发时）
5. `py -3`（Windows），然后是 PATH 里的 `python` / `python3`

每个候选都会先试着导入依赖，都不行时启动页会列出每个候选失败的原因，并给出安装命令。

## 和浏览器版的区别

| | 浏览器版（`agent ui`） | 桌面端 |
| --- | --- | --- |
| 启动 | 终端里运行命令 | 双击应用 |
| 选择项目目录 | 后端用 tkinter 弹窗 | Electron 原生对话框 |
| 外部链接 | 浏览器内打开 | 系统浏览器打开 |
| 后端异常退出 | 页面显示断开 | 回到启动页，显示最后的日志，可一键重试 |

控制台页面里只多了一处判断：检测到 `window.wwkDesktop` 时用原生对话框选目录。preload 只暴露选择目录、启动状态、重试、选择解释器、复制这几个固定能力，主进程只接受来自启动页和本机控制台页的请求。

## 开发

需要 Node ≥ 22.18（electronup 的要求）和 pnpm。

```bash
cd desktop
```

```bash
pnpm install
```

```bash
pnpm dev
```

开发时会自动找到仓库根目录的 `.venv`（按 [development.md](development.md) 创建），也可以设 `WWK_PYTHON` 指定解释器。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 渲染进程热更新，主进程改动后自动重启 |
| `pnpm build:dir` | 只生成免安装目录 `dist/out/win-unpacked`，用来快速检查打包结果 |
| `pnpm build:win` / `build:mac` / `build:linux` | 生成安装包（mac 只能在 macOS 上打，linux 不能在 Windows 上打） |
| `pnpm typecheck` / `pnpm lint` | 类型检查 / 代码风格 |

`pnpm install` 后若 `node_modules/electron/dist` 不存在（Electron 下载被跳过），运行一次 `node node_modules/electron/install.js`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `main/index.ts` | 窗口、菜单、IPC、生命周期 |
| `main/python.ts` | 查找并检查 Python 解释器 |
| `main/backend.ts` | 启动 / 停止控制台后端，解析地址，保留最近日志 |
| `preload/index.ts` | 暴露给页面的 `window.wwkDesktop` |
| `render/` | 启动页：启动进度、找不到 Python 或后端退出时的说明 |
| `electronup.config.ts` | 构建与打包配置（含 Python 源码的 `extraResources`） |

## 已知限制

- 还没有应用图标，用的是 Electron 默认图标。
- 安装包没有签名，Windows 首次运行可能出现 SmartScreen 提示。
- 不内置 Python 运行时，需要用户自己装好依赖。
- 只在 Windows 上实测过免安装目录（`build:dir`）的启动、崩溃重试和退出清理；`pnpm dev` 和 macOS / Linux 安装包还没实测。
