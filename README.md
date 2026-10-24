# web-workflow-kit

本地前端交付流水线：把“提需求 → 读设计稿 → 写 Spec → 写代码 → 构建 → 门禁 → 验收 → 失败回环 → 交付”串成一条自动流程，覆盖 **Web 中后台、UniApp、微信/支付宝小程序、Electron 桌面端**。

它是一个 TypeScript 写的 LangGraph 应用，只依赖 Node：可以用**桌面端**（双击打开），也可以装成 `wwk` 命令，用 `wwk ui` 打开纯本地的中文网页控制台，或直接在命令行里跑。

```
需求 ─→ 编码（设计稿 → Spec → 写代码）─→ 门禁 ─┬─ 通过 ──────────────→ 交付（代码不提交，等人签字发布）
                                         ▲     ├─ 失败且未超限 → 审阅修复 ─┐
                                         └─────┼───────────────────────────┘
                                               └─ 规则错误 / 修复到上限 / 需要人决定 / agent 出错 → 熔断（邮件通知，人介入）
```

## 设计原则

| 原则 | 含义 |
| --- | --- |
| 门禁唯一 | 只有门禁脚本的退出码能放行；任何模型都无权覆盖 |
| 零 token 优先 | 能用脚本判定的绝不调模型；门禁全绿直接交付 |
| 硬性熔断 | 修复轮数上限写死在代码里，到上限必熔断，邮件通知人介入 |
| 模型异构 | 写代码、验收、修复可以用不同的 agent，避免同源偏差 |
| 输入最小化 | 只传本次改动块和失败项，验收每次无状态 |
| 多端通用 | 四类项目共用同一张图，差异只在 `rules.yaml` |

人仍在两处签字：熔断时、发布前。流水线交付后**不会提交代码**。

## 快速开始

需要 **Node ≥ 22.18**（门禁和 agent 都要用到）。

**1. 安装**

两种方式任选：

- **桌面端**：按 [docs/desktop.md](docs/desktop.md) 打包或运行 `desktop/`，双击打开即可，不用开终端；
- **命令行**：克隆仓库后装成全局的 `wwk` 命令（需要 pnpm）：

```bash
git clone https://github.com/TaiAiAc/web-workflow-kit && cd web-workflow-kit/core
```

```bash
pnpm install && pnpm build && npm install -g .
```

网络需要代理时，先设置 `HTTPS_PROXY`（如 `export HTTPS_PROXY=http://127.0.0.1:7890`，换成你的代理地址）。

**2. 准备要用到的 agent**

| 用途 | 需要 |
| --- | --- |
| 生成 Spec、写代码（默认） | 安装并登录 [Claude Code](https://claude.com/claude-code)：`npm install -g @anthropic-ai/claude-code`，终端里运行一次 `claude` 按提示登录 |
| 修复（默认） | 安装 DeepSeek Harness（`dsh` 命令可用）并配好 `DEEPSEEK_API_KEY`；也可以在控制台的「修复」里换成其他已安装的 agent |
| 验收审阅 | 可选：配置 `DEEPSEEK_API_KEY`；不配则自动改用 dsh，见[验收审阅](#验收审阅) |
| 熔断邮件 | 可选：SMTP 配置 |

这些都可以在控制台的**设置页**里看状态、点「登录」、填 Key 和代理：写进 `~/.web-workflow-kit/.env`（所有项目共用）或项目自己的 `.env`，模板见 [.env.example](.env.example)。

**3. 在前端项目里生成配置**

```bash
wwk init --project /path/to/my-app
```

会在项目根目录生成 `rules.yaml`（门禁规则）和 `agent.config.json`（流水线配置），已存在的文件不会覆盖。**打开 `rules.yaml`，把 `project_type` 和各项命令改成你项目里真实存在的命令**，再把 `.agent/` 加进项目的 `.gitignore`。控制台里对没有 `rules.yaml` 的项目也有「生成配置」按钮。

**4. 先只跑门禁，确认规则对得上**

```bash
wwk verify --project /path/to/my-app
```

退出码就是结论：`0` 通过、`1` 未通过、`2` 规则或环境有误。

**5. 打开控制台**

```bash
wwk ui
```

## 本地控制台

`wwk ui` 启动后浏览器自动打开 `http://127.0.0.1:8765/`（`--port` 换端口，`--no-browser` 不自动打开）。

同一个控制台也有桌面端（`desktop/`，Electron）：双击打开，后端跑在 Electron 自带的 Node 上；用系统对话框选目录，退出即停止。见 [docs/desktop.md](docs/desktop.md)。

控制台按**工作空间**管理项目，尽量用按钮代替输入：

**左侧：工作空间**
- 「＋」选一个项目目录加进来；每个项目显示上次运行的结果、时间和 git 分支；
- 「…」菜单：在文件管理器中打开、从工作空间移除（不删任何文件）；
- 列表存在 `~/.web-workflow-kit/workspaces.json`，浏览器版和桌面端共用。

**右侧：选中的项目**
- 工具栏：「跑门禁」只跑一次门禁；「修复回环」对当前改动跑门禁，失败就审阅修复，直到通过或熔断；「打开目录」；项目没有 `rules.yaml` 时会提示「生成配置」；
- 需求框：写需求点「运行」（`⌘/Ctrl + Enter`）跑完整流水线；「最近」里点一下就能复用之前的需求；「设计稿」可选本地 `.json` 或一键用 MasterGo 当前选中的图层；
- 编程 / 修复 / 审阅：点按钮选，每个项目记住自己的选择；本机没装的选项会划掉；
- 流程进度条：按实际发生的顺序排出 Spec → 写代码 → 门禁 → 审阅 → 修复 → 门禁 #2 → 交付 / 熔断，每一步显示用了哪个 agent、耗时，失败的门禁直接标出哪几项没过，回环用 ⟳ 标出；
- 门禁检查项：最近一次门禁的 typecheck / lint / test / build … 逐项 ✔ / ✘，以及已修复几轮；
- 日志按步骤分组、可折叠，点进度条上的任一步只看那一步的日志；运行中自动跟随最新输出。

**设置**（侧栏左下）
- 各 agent 是否安装、是否已登录、版本；没装的给安装命令，可登录的点「登录」在系统终端里打开登录命令（带上配置的代理）；
- 代理（「用系统代理」一键填入并保存，并检测到 Anthropic / OpenAI / DeepSeek / npm 的连通性）、API Key（只写不读，DeepSeek Key 可一键测试）、熔断邮件；
- 可以写全局，也可以只写当前项目的 `.env`（项目覆盖全局）；对下一次运行生效。

运行记录在结束时写进项目的 `.agent/runs/`（每个项目保留最近 50 条），服务重启后仍可回看；交付记录另存 `.agent/delivery.json`。编码子图、审阅修复子图的单独调试在 LangGraph Studio 或 API 里用。

控制台只在本机运行，页面不加载任何外部资源。安全细节见 [docs/architecture.md](docs/architecture.md#安全)。

## 命令行

```bash
wwk --project /path/to/my-app
```

在终端里不带命令即进入交互模式，直接输入需求就跑完整流水线（`wwk repl` 不要求终端，可以用管道喂命令）。

| 交互模式输入 | 作用 |
| --- | --- |
| 需求原文 | 跑完整流水线 |
| `:verify` | 只跑门禁 |
| `:fix` | 对当前改动跑门禁 ⇄ 审阅修复 |
| `:code <需求>` | 只生成 Spec 并写代码，不过门禁 |
| `:design <ref>` | 下一条需求附带设计稿：本地 `.json`，或 `mastergo` |
| `:agent <名称>` | 切换编程 agent |
| `:resume [线程]` | 从断点继续被中断的运行 |
| `:project <目录>` / `:status` / `:help` / `:q` | 切换项目 / 上次结果 / 帮助 / 退出 |

| 命令 | 作用 |
| --- | --- |
| `wwk run "需求" [--design <ref>]` | 非交互跑一次完整流水线，退出码 0 = 交付、1 = 熔断 |
| `wwk fix` | 对当前改动跑门禁 ⇄ 审阅修复 |
| `wwk verify` | 只跑门禁，退出码 0/1/2 |
| `wwk resume [线程]` | 从断点继续被中断的运行 |
| `wwk init` | 复制默认 `rules.yaml`、`agent.config.json` 到项目 |
| `wwk ui [--port 8765] [--no-browser]` | 打开本地控制台 |

| 公共参数 | 作用 |
| --- | --- |
| `--project <目录>` | 目标项目（默认当前目录） |
| `--agent claude\|codex\|opencode\|workbuddy\|dsh` | 写代码用哪个 agent |
| `--fix-agent <同上>` | 修复用哪个 agent（默认取配置 `fix`，即 dsh） |
| `--review auto\|api\|dsh\|skip` | 验收审阅方式 |
| `--config <文件>` | 额外的配置文件 |
| `--json` | stdout 只输出结果 JSON，日志走 stderr（给脚本用） |
| `--version` / `--help` | 版本 / 用法 |

## 编程 agent

“写代码”这一步可以换 agent：控制台的「编程」按钮、`--agent`、交互模式的 `:agent`，或配置 `code.agent`（默认 `claude`）。

| 选项 | 调用方式 | 前提 |
| --- | --- | --- |
| Claude Code（`claude`） | `claude -p` | 安装并登录 Claude Code |
| Codex（`codex`） | ACP 协议，适配器 `codex-acp` | 安装 Codex（`npm install -g @openai/codex`），已登录或在 `~/.codex/config.toml` 配好模型服务 |
| OpenCode（`opencode`） | ACP 协议，`opencode acp` | 安装并登录 OpenCode |
| WorkBuddy（`workbuddy`） | ACP 协议，`codebuddy --acp`（只开放文件工具，不给 Bash） | 安装 WorkBuddy 的引擎 CodeBuddy Code（`npm install -g @tencent-ai/codebuddy-code`），运行一次 `codebuddy` 登录 |
| DeepSeek Harness（`dsh`） | `dsh headless` | 安装 DeepSeek Harness，配好 `DEEPSEEK_API_KEY` |

Codex 的 ACP 适配器默认每次经 npx 下载，网络不稳时会在开始写代码前就失败；先全局安装一次（`npm install -g @agentclientprotocol/codex-acp@1.13.0`），之后直接用本机的 `codex-acp`，不再访问 npm。

经 ACP 的 Codex / OpenCode / WorkBuddy 受权限策略约束：改不了 `rules.yaml`、门禁文件和流水线配置，也写不到项目以外。ACP 预设可以用 `model` 指定模型（OpenCode 支持）。agent 一轮下来什么都没做（0 token、无输出，常见于 Key 失效或没登录）会按出错熔断，不会白白耗掉修复轮数。登录状态在设置页里看。

生成 Spec 不受这个选项影响，默认仍用 Claude Code（可改为 GPT，见 [docs/configuration.md](docs/configuration.md#spec)）。

## 验收审阅

门禁失败后，先由“验收顾问”读失败项和改动块，给出修复计划，再交给修复 agent（默认 dsh）去改。修复 agent 和编程 agent 一样可以选：控制台的「修复」按钮、`--fix-agent`，可选项相同；建议和编程 agent 选不同的，避免同源偏差。

| 选项 | 行为 |
| --- | --- |
| 自动（默认） | 配了 `DEEPSEEK_API_KEY` 用 API；没配但装了 dsh 就用 dsh；都没有就跳过 |
| DeepSeek API | 直接调接口：天然只读，强制 JSON 输出 |
| DeepSeek Harness | 用 dsh 审阅；审阅前后比对项目文件，顾问若改动了任何文件即判违规并熔断，列出被改文件交给人处理 |
| 跳过 | 不出计划，修复 agent 直接按失败码和出错位置修 |

所以 **DeepSeek API Key 不是必需的**。无论哪种方式，顾问都没有放行权。

## 设计稿（MasterGo）

流水线可以把设计稿交给 Spec 生成：

- **本地文件**：设计稿字段填导出的 `.json` 路径；
- **MasterGo**：在项目的 `agent.config.json` 里设 `design.enabled: true`，在 MasterGo 客户端里**选中目标页面或图层**，设计稿字段填 `mastergo`（命令行是 `--design mastergo` 或交互模式的 `:design mastergo`）。

读取的是本机正在运行的 MasterGo 客户端（默认 `http://localhost:30678`）里当前选中的图层和文件变量，不是按链接取稿。没选中图层时会以“设计稿读取失败”停下，不发邮件，选中后重跑即可。

## Electron 视觉验收

门禁可以真正启动打包后的 exe，检查首屏：期望的文字和元素是否出现、是否白屏、渲染进程有没有未捕获异常，并截图到 `.agent/visual.png`。纯脚本判定，不调模型。默认关闭，在 `rules.yaml` 的 Electron 配置里把 `visual` 加进 `checks` 即可，见 [docs/rules.md](docs/rules.md#visual视觉验收)。

## 运行产物

都在目标项目的 `.agent/` 目录下：

| 文件 | 内容 |
| --- | --- |
| `spec.md` | 本次生成的 Spec |
| `verify-report.json` | 最近一次门禁报告（含全部失败项） |
| `code-task.md` / `fix-task.md` / `review-task.md` | 交给命令行 agent 的任务 |
| `delivery.json` | 交付记录：需求、修复轮数、改动文件、各轮门禁结果 |
| `runs/<id>.json` | 控制台的运行记录（步骤、日志、结论），最近 50 条 |
| `checkpoints.sqlite` / `last_thread.json` | 断点（`wwk resume`、`:resume` 用） |
| `repl_history` | 交互模式的输入历史 |
| `visual.png` | Electron 视觉验收截图 |
| `.notify_cache` | 熔断邮件去重记录 |

## 常见问题

**`--verify` 一上来就是一串 `*_FAIL`**
默认 `rules.yaml` 里的命令（`pnpm exec vue-tsc` 等）不一定和你的项目一致。用 `--init` 生成后，按项目实际的 `package.json` 脚本改。

**结论是 `GATE_CONFIG_ERROR`（门禁规则或运行环境有误）**
`rules.yaml` 写错或 Node 不可用。这类错误模型无权也无法修，流水线直接熔断。具体原因在门禁失败项里。

**Spec 生成失败：`Not logged in · Please run /login`**
Claude Code 没登录。终端运行 `claude` 登录后重试。

**Claude Code 登录时报 `403`，或 claude / codex 连不上**
国内网络访问 Anthropic、OpenAI 需要代理；命令行程序不会自动用系统代理。在设置页里填 `HTTPS_PROXY`（「用系统代理」一键保存）并点「检测连通性」，再用设置页的「登录」按钮重新登录。

**OpenCode / dsh 一轮下来什么都没改就熔断了：`agent 本轮没有任何输出`**
多半是该 agent 自己的 Key 失效或没登录（比如 OpenCode 里存的 DeepSeek Key 无效）。在 agent 自己的配置里换一个能用的 Key，或在 `agent.config.json` 里给它的预设设 `model`。

**`npx` / `gh` / `git` 访问 GitHub、npm 超时**
它们不读 `.gitconfig` 里的代理，需要设置 `HTTPS_PROXY` 环境变量。

## 已知限制

- 同一个项目同一时间只能有一次运行。
- 真实项目上跑通过完整流程的：Claude Code（编程）、Codex（编程、修复）。OpenCode 在本机因自身的 Key 失效没能完成修复（流水线按出错熔断并给出原因）；WorkBuddy、dsh 还没在真实项目上跑过。
- Electron 视觉验收只在 Windows 上用 Electron 45 实测过；应用若在生产包里禁用了远程调试，会报 `VISUAL_UNAVAILABLE`。

## 文档

- [docs/configuration.md](docs/configuration.md)：`agent.config.json` 与 `.env` 全部配置项
- [docs/rules.md](docs/rules.md)：`rules.yaml`、各项检查与失败码
- [docs/architecture.md](docs/architecture.md)：图与节点、原则如何落地、安全模型、LangGraph Studio / API
- [docs/development.md](docs/development.md)：开发、测试、打包、CI
- [docs/desktop.md](docs/desktop.md)：桌面端（Electron）：工作方式、开发与打包
- [core/README.md](core/README.md)：TS 核心：模块与实现要点
