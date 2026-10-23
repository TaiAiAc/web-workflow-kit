# web-workflow-kit

本地前端交付流水线：把“提需求 → 读设计稿 → 写 Spec → 写代码 → 构建 → 门禁 → 验收 → 失败回环 → 交付”串成一条自动流程，覆盖 **Web 中后台、UniApp、微信/支付宝小程序、Electron 桌面端**。

它是一个独立的 LangGraph 应用：`pip install` 后在任何目录可用，用 `agent ui` 打开纯本地的中文网页控制台，或用 `agent` 命令行。

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

需要 **Python ≥ 3.10** 和 **Node ≥ 22**。门禁已打包成单文件，不需要 `npm install`。

**1. 安装**（建议放在独立的虚拟环境里）

```bash
python -m venv $env:USERPROFILE\wwk-venv
```

```bash
& $env:USERPROFILE\wwk-venv\Scripts\python.exe -m pip install "web-workflow-kit[all] @ git+https://github.com/TaiAiAc/web-workflow-kit"
```

macOS / Linux：

```bash
python3 -m venv ~/wwk-venv
```

```bash
~/wwk-venv/bin/python -m pip install "web-workflow-kit[all] @ git+https://github.com/TaiAiAc/web-workflow-kit"
```

macOS 自带的 `python3` 是 3.9，需要先装更新的版本（如 `brew install python@3.12`，再用 `python3.12 -m venv`）。

网络需要代理时，先设置 `$env:HTTPS_PROXY = 'http://127.0.0.1:7897'`（换成你的代理地址）。

**2. 准备要用到的 agent**

| 用途 | 需要 |
| --- | --- |
| 生成 Spec、写代码（默认） | 安装并登录 [Claude Code](https://claude.com/claude-code)：终端里运行一次 `claude` 按提示登录 |
| 修复（默认） | 安装 DeepSeek Harness（`dsh` 命令可用）；也可以在控制台的「修复 agent」里换成其他已安装的 agent |
| 验收审阅 | 可选：配置 `DEEPSEEK_API_KEY`；不配则自动改用 dsh，见[验收审阅](#验收审阅) |
| 熔断邮件 | 可选：SMTP 配置 |

密钥和 SMTP 写在 `~/.web-workflow-kit/.env`（所有项目共用），模板见 [.env.example](.env.example)。

**3. 在前端项目里生成配置**

```bash
agent --project D:/projects/my-app --init
```

会在项目根目录生成 `rules.yaml`（门禁规则）和 `agent.config.json`（流水线配置），已存在的文件不会覆盖。**打开 `rules.yaml`，把 `project_type` 和各项命令改成你项目里真实存在的命令**，再把 `.agent/` 加进项目的 `.gitignore`。

**4. 先只跑门禁，确认规则对得上**

```bash
agent --project D:/projects/my-app --verify
```

退出码就是结论：`0` 通过、`1` 未通过、`2` 规则或环境有误。

**5. 打开控制台**

```bash
agent ui
```

## 本地控制台

`agent ui` 启动后浏览器自动打开 `http://127.0.0.1:8765/`（`--port` 换端口，`--no-browser` 不自动打开）。

同一个控制台也有桌面端（`desktop/`，Electron）：双击打开，自动找 Python、启动后端，用系统对话框选目录，关窗即停止。见 [docs/desktop.md](docs/desktop.md)。

**左侧：发起运行**
1. 选一张图：
   - **前端交付流水线**：从需求开始，完整跑一遍；
   - **门禁修复回环**：不写新代码，对现有改动跑门禁，失败就审阅修复，人工改完后复验也用它；
   - **编码子图 / 审阅修复子图**：单独调试某一段。
2. 点「浏览…」选项目目录（也可以手输，或从最近项目里选）。选好后会提示有没有 `package.json`、`rules.yaml`、是不是 git 仓库。
3. 填需求，按需选择「编程 agent」「验收审阅」和设计稿，点「运行」。

**右侧：看结果**
- 流程图：节点实时变色（运行中蓝、完成绿、熔断红），实际走过的路径高亮；
- 结论：中文的一句话结论，例如“已交付：门禁通过，本次改动 3 个文件……”或“已熔断：……”；
- 门禁失败项：失败码、检查项、出错位置；
- 日志：实时输出，包括门禁每一项检查的 ✔ / ✘。

左下的运行记录可以回看本次服务启动以来的运行；服务重启后清空，交付记录始终保存在项目的 `.agent/delivery.json`。

控制台只在本机运行，页面不加载任何外部资源。安全细节见 [docs/architecture.md](docs/architecture.md#安全)。

## 命令行

```bash
agent --project D:/projects/my-app
```

不带命令即进入 REPL，直接输入需求就跑完整流水线。

| REPL 输入 | 作用 |
| --- | --- |
| 需求原文 | 跑完整流水线 |
| `:verify` | 只跑门禁 |
| `:fix` | 对当前改动跑门禁 ⇄ 审阅修复 |
| `:code <需求>` | 只生成 Spec 并写代码，不过门禁 |
| `:design <ref>` | 下一条需求附带设计稿：本地 `.json`，或 `mastergo` |
| `:agent <名称>` | 切换编程 agent |
| `:resume [线程]` | 从断点继续被中断的运行 |
| `:project <目录>` / `:status` / `:help` / `:q` | 切换项目 / 上次结果 / 帮助 / 退出 |

| 参数 | 作用 |
| --- | --- |
| `agent ui [--port 8765] [--no-browser]` | 打开本地控制台 |
| `--project <目录>` | 目标项目（默认当前目录） |
| `--once "需求"` | 非交互跑一次，退出码 0 = 交付、1 = 熔断 |
| `--verify` | 只跑门禁，退出码 0/1/2 |
| `--init` | 复制默认 `rules.yaml`、`agent.config.json` 到项目 |
| `--agent claude\|codex\|opencode\|workbuddy\|dsh` | 写代码用哪个 agent |
| `--fix-agent <同上>` | 修复用哪个 agent（默认取配置 `fix`，即 dsh） |
| `--review auto\|api\|dsh\|skip` | 验收审阅方式 |
| `--config <文件>` / `--version` | 额外配置文件 / 版本 |

## 编程 agent

“写代码”这一步可以换 agent：控制台的「编程 agent」下拉框、`--agent`、REPL 的 `:agent`，或配置 `code.agent`（默认 `claude`）。

| 选项 | 调用方式 | 前提 |
| --- | --- | --- |
| Claude Code（`claude`） | `claude -p` | 安装并登录 Claude Code |
| Codex（`codex`） | ACP 协议，经 npx 按需拉起适配器 | 有 npx，已登录 Codex 或配好 OpenAI Key |
| OpenCode（`opencode`） | ACP 协议，`opencode acp` | 安装并登录 OpenCode |
| WorkBuddy（`workbuddy`） | ACP 协议，`codebuddy --acp` | 安装 WorkBuddy 的引擎 CodeBuddy Code（`npm install -g @tencent-ai/codebuddy-code`），运行一次 `codebuddy` 登录 |
| DeepSeek Harness（`dsh`） | `dsh headless` | 安装 DeepSeek Harness |

经 ACP 的 Codex / OpenCode / WorkBuddy 受权限策略约束：改不了 `rules.yaml`、门禁文件和流水线配置，也写不到项目以外。控制台会标出本机找不到命令的选项；是否已登录只有真正调用时才知道。

生成 Spec 不受这个选项影响，默认仍用 Claude Code（可改为 GPT，见 [docs/configuration.md](docs/configuration.md#spec)）。

## 验收审阅

门禁失败后，先由“验收顾问”读失败项和改动块，给出修复计划，再交给修复 agent（默认 dsh）去改。修复 agent 和编程 agent 一样可以选：控制台的「修复 agent」下拉框、`--fix-agent`，可选项相同；建议和编程 agent 选不同的，避免同源偏差。

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
- **MasterGo**：安装 `[mcp]` 可选依赖，在项目的 `agent.config.json` 里设 `design.enabled: true`，在 MasterGo 客户端里**选中目标页面或图层**，设计稿字段填 `mastergo`。

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
| `checkpoints.sqlite` | 断点（`:resume` 用） |
| `visual.png` | Electron 视觉验收截图 |
| `.notify_cache` | 熔断邮件去重记录 |

## 常见问题

**`--verify` 一上来就是一串 `*_FAIL`**
默认 `rules.yaml` 里的命令（`pnpm exec vue-tsc` 等）不一定和你的项目一致。用 `--init` 生成后，按项目实际的 `package.json` 脚本改。

**结论是 `GATE_CONFIG_ERROR`（门禁规则或运行环境有误）**
`rules.yaml` 写错或 Node 不可用。这类错误模型无权也无法修，流水线直接熔断。具体原因在门禁失败项里。

**Spec 生成失败：`Not logged in · Please run /login`**
Claude Code 没登录。终端运行 `claude` 登录后重试。

**控制台运行时报“拒绝访问”**
运行控制台的 Python 没有权限写目标项目目录。用普通权限的终端、在独立虚拟环境里启动 `agent ui`。

**中文显示成 `?`**
控制台编码不是 UTF-8 时，打不出的字符会被替换（不会再导致崩溃）。可以在 Windows 终端里改用 UTF-8，或设置 `$env:PYTHONUTF8 = '1'`。

**`pip` / `npx` / `gh` 访问 GitHub、npm 超时**
它们不读 `.gitconfig` 里的代理，需要设置 `HTTPS_PROXY` 环境变量。

## 已知限制

- 控制台的运行记录只在内存里，服务重启后清空（交付记录仍在 `.agent/delivery.json`）。
- 同一个项目同一时间只能有一次运行。
- Codex、OpenCode、WorkBuddy、dsh 作为编程 / 修复 agent，以及 dsh 作为审阅顾问，目前只用模拟 agent 验证过接入，还没在真实项目上跑过完整流程。
- Electron 视觉验收只在 Windows 上用 Electron 45 实测过；应用若在生产包里禁用了远程调试，会报 `VISUAL_UNAVAILABLE`。

## 文档

- [docs/configuration.md](docs/configuration.md)：`agent.config.json` 与 `.env` 全部配置项
- [docs/rules.md](docs/rules.md)：`rules.yaml`、各项检查与失败码
- [docs/architecture.md](docs/architecture.md)：图与节点、原则如何落地、安全模型、LangGraph Studio / API
- [docs/development.md](docs/development.md)：开发、测试、打包、CI
- [docs/desktop.md](docs/desktop.md)：桌面端（Electron）：启动方式、Python 查找顺序、开发与打包
