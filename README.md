# web-workflow-kit

一个独立的 LangGraph 应用：本地前端交付流水线。可以 `pip install` 后在任何目录用 `agent` 命令，也可以用 `langgraph dev` 在 LangGraph Studio 里打开、看图、单步运行。

```
需求 → 设计稿 → Spec → 写代码 → verify.ts 门禁 ─┬─ exit 0 → 交付（待人工签字）
                                    ▲          ├─ exit 1 且未超限 → DeepSeek 审阅 → dsh 修复 ─┐
                                    └──────────┼──────────────────────────────────────────────┘
                                               └─ exit 2 / 超限 / needs_human / agent error → 熔断 + 邮件
```

Web、UniApp、小程序、Electron 共用同一张图；场景差异只在 `rules.yaml` 里配置。

## 原则在代码里的落点

| 原则 | 落点 |
| --- | --- |
| 门禁唯一 | `main_graph.route_after_verify` 只看 `verify_exit`；`deps.validate_plan` 丢弃顾问输出里的 `pass` 字段 |
| 零 token 优先 | 门禁全绿直接 `deliver`，不调审阅；`:verify` 只跑脚本 |
| 硬性熔断 | `attempt` 计数在 `verify_node` 里累加，`attempt > max_retries` 必进 `breaker` |
| 模型异构 | 写代码 `code.backend=claude_cli`；审阅 `review` 走 DeepSeek；修复 `fix` 走 `dsh headless` |
| 输入最小化 | `diffs.changed_hunks` 只取本次改动块（失败点名的文件优先，按字符预算截断）；门禁只回传失败项且只留输出尾部；审阅每次只有 system + 本轮 payload |

## 目录

```
langgraph.json                      LangGraph 应用描述：登记 4 张图，供 langgraph dev / Studio 加载
web_workflow_kit/                   Python 包（pip 安装的就是它）
  graph.py                          应用入口：pipeline、fix_loop、codegraph、reviewgraph
  cli.py                            `agent` 命令（REPL / --once / --verify / --init）
  pipeline/                         图与节点：main_graph、codegraph、reviewgraph、门禁调用、各后端
  assets/                           随包分发的默认值
    agent.config.json               版本、重试上限、各节点后端
    rules.yaml                      门禁规则（project_type + 各端 profiles）
    prompts/review-prompt.md        验收顾问契约（输入/输出 JSON、失败码表）
    prompts/*.md                    Spec / 编码 / 修复提示词
    verify.mjs                      门禁脚本的单文件打包产物（生成文件，勿手改）
verify/                             门禁源码（TypeScript）与测试；`pnpm build` 生成 assets/verify.mjs
tests/                              Python 测试
.env.example                        SMTP / API Key 模板
```

## 安装

运行时只需要 **Python ≥ 3.10** 和 **Node ≥ 22**（门禁已打包成单文件，不需要 `npm install`）。

```bash
pip install "web-workflow-kit[all] @ git+https://github.com/TaiAiAc/web-workflow-kit"
```

可选能力按需装：`[checkpoint]`（`:resume` 断点恢复）、`[mcp]`（MasterGo 设计稿）、`[acp]`（ACP 编码后端）、`[repl]`（历史记录）、`[studio]`（`langgraph dev` / Studio）；`[all]` 全装。

密钥与 SMTP 放用户级 `~/.web-workflow-kit/.env`（所有项目共用，可用 `WWK_HOME` 改位置），或项目根目录的 `.env`（优先）。模板见 `.env.example`。

在前端项目里生成可改的配置（已存在的文件不覆盖）：

```bash
agent --project ../my-app --init
```

## 使用

只跑门禁（任何项目，零 token；退出码即结论，可直接放进 CI）：

```bash
agent --project ../my-app --verify
```

### LangGraph Studio

在本仓库根目录（`langgraph.json` 所在处）启动本地 LangGraph 服务：

```bash
langgraph dev
```

浏览器打开它打印的 Studio 链接（`https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024`），可以看到四张图：

| Studio 里的名字 | 图 ID（API 用） | 节点 | 输入表单 |
| --- | --- | --- | --- |
| 前端交付流水线 | `pipeline` | 编码 → 门禁 ⇄ 审阅修复 → 交付 / 熔断 | 项目路径、需求、设计稿（可选） |
| 门禁修复回环 | `fix_loop` | 门禁 ⇄ 审阅修复 → 交付 / 熔断 | 项目路径 |
| 编码子图 | `codegraph` | 读取设计稿 → 生成Spec → 写代码 | 同 pipeline |
| 审阅修复子图 | `reviewgraph` | 验收审阅 → 执行修复 | 项目路径、门禁失败项等 |

显示层是中文：图名、描述、节点名、输入表单的标题和说明，以及运行结果里的 `summary`（中文结论，如“已熔断：已自动修复到上限仍未通过门禁……”）。对外契约保持英文不变：图 ID、输入/状态字段名、`status`（`delivered` / `broken`）、`break_reason`、失败码。Studio 自身的按钮和菜单由 LangChain 提供，不在本项目控制范围内。

“项目路径”填目标前端项目的绝对路径。每次运行都按该项目的 `agent.config.json` / `.env` / `rules.yaml` 现取配置，所以一个服务可以同时服务多个项目，改了配置下次运行就生效。检查点由服务端管理，Studio 里可以回看每个节点的 state。

**中文 Windows 注意**：langgraph-api 读取自带的 `openapi.json` 时没指定编码，系统默认 GBK 会直接启动失败，需开启 Python 的 UTF-8 模式：

```bash
$env:PYTHONUTF8 = '1'; langgraph dev
```

### REPL

```bash
agent --project ../my-app
```

| 输入 | 作用 |
| --- | --- |
| 需求原文 | 完整流水线 |
| `:design <ref>` | 下一条需求附带设计稿：本地 `.json`，或 `mastergo`（读 MasterGo 当前选中图层 + 文件变量） |
| `:code <需求>` | 只跑 codegraph |
| `:verify` | 只跑门禁 |
| `:fix` | 对当前工作区跑门禁 ⇄ 修复闭环 |
| `:resume [thread]` | 从检查点继续被中断的运行（默认最近一次） |
| `:status` / `:project <dir>` / `:q` | |

非交互：`agent --project ../my-app --once "需求"`，退出码 0 = 交付，1 = 熔断。

运行产物在目标项目的 `.agent/`：`spec.md`、`verify-report.json`、`fix-task.md`、`delivery.json`、`checkpoints.sqlite`、`.notify_cache`。请把 `.agent/` 加进目标项目的 `.gitignore`。

### MasterGo 设计稿

`@mastergo/vibe-mcp` 连的是**本机正在运行的 MasterGo 客户端**（默认 `http://localhost:30678`），不按链接取稿：

1. `pip install -e .[mcp]`，`agent.config.json` 里设 `design.enabled: true`（端口不同就改 `design.mcp.url`）。
2. 在 MasterGo 里选中目标页面或图层。
3. REPL 里 `:design mastergo`，再输入需求。

读取 `design.tools`（默认 `get_selection_node`、`get_variables`）：选中图层拆成 `summary` + `code`（HTML），变量压成 `{变量名: 值}` 的 token 表；每个工具单独按 `max_chars` 分预算。没选中图层会直接以 `DESIGN_ERROR` 停下（不发邮件），选中后重跑即可。

### ACP 编码后端

`agent.config.json` 里把 `code.backend` 设为 `"acp"`（`code.agent` 可选 `claude` / `codex`，或用 `code.command` 指定任意 ACP CLI）。stop_reason 直接取自 ACP 协议。写文件要经 `session/request_permission`，由流水线应答：

- 默认只批准 `read` / `search` / `think` / `edit`，`execute` 等一律拒绝（`code.allow_kinds` 可改）；
- 写到项目外、或命中 `code.protected`（默认 `rules.yaml`、`verify/*`、`agent.config.json`、`.agent/*`、`.github/*`、`.env*`）的编辑一律拒绝——门禁文件在协议层就改不了；
- 被拒的请求会附在结果文本里。

Claude 适配器经 `npx @agentclientprotocol/claude-agent-acp` 拉起，需要本机已登录 Claude Code 或设置 `ANTHROPIC_API_KEY`。

### 断点恢复

装了 `.[checkpoint]` 后，主图每个节点结束都会把 state 写进 `.agent/checkpoints.sqlite`。进程崩溃或被中断后 `:resume` 从最后完成的节点继续，已完成的节点（例如已写完的代码）不会重跑；中断时正在跑的那个节点会重跑。`checkpoint.enabled: false` 可关闭。

### 网络代理

`gh`、`npx` 和 Python 不会读 `.gitconfig` 里的代理。如果 git 走代理才能访问 GitHub/npm，先在终端里设置 `HTTPS_PROXY`（例如 `$env:HTTPS_PROXY = 'http://127.0.0.1:7897'`）。

## rules.yaml

- `project_type`：`electron | web | uniapp | miniprogram`，可被 `--type` / `agent.config.json` 的 `verify.type` 覆盖。
- `commands`：各端共用的命令检查；`profiles.<type>.<id>` 同名条目覆盖它。
- 任何带 `run` 的条目都是命令检查，失败码默认 `<ID>_FAIL`，可用 `code:` 指定。
- 内置检查：`artifacts`、`package_size`（小程序主包，自动排除 `subPackages`）、`unpacked`（asar 条目 + 版本）、`installer`（latest.yml 版本与 sha512、可选 SHA256SUMS、文件名含版本）、`smoke`（启动后存活 `alive_ms`）。
- `build` 失败时，依赖产物的检查直接 `skip`，不制造连带失败项。
- `visual`（Electron，可选）：带 `--remote-debugging-port=0` 起应用，经 Chrome DevTools Protocol 连渲染进程，在 `timeout_ms` 内等 `expect_text` / `expect_selector` 成立，检查白屏、`forbid_text`、未捕获异常，并截图到 `.agent/visual.png`。纯脚本判定，不调模型；应用若禁用了远程调试则报 `VISUAL_UNAVAILABLE`。没有用 agent-electron：它对打包后应用的启动仍标为 WIP，而门禁验的正是 `win-unpacked` 里的 exe。

失败码表见 [web_workflow_kit/assets/prompts/review-prompt.md](web_workflow_kit/assets/prompts/review-prompt.md)，新增失败码时同步更新。

## 开发

```bash
python -m venv .venv
```

```bash
.venv/Scripts/python -m pip install -e ".[all]"
```

```bash
cd verify && pnpm install
```

改了 `verify/` 下的 TypeScript 后必须重新打包并提交产物（CI 会校验两者一致）：

```bash
cd verify && pnpm build
```

构建后端是 hatchling：setuptools 的 editable 构建会在临时目录里嵌套很深的 egg-info，路径较深的工作区在 Windows 上会超过 260 字符。

## 测试

```bash
cd verify && pnpm test
```

```bash
python -m unittest discover tests
```

`verify/test/visual.test.ts` 用本机 Edge/Chrome 代替 Electron 跑真实 CDP（同一协议），找不到浏览器时跳过，可用 `CHROME_PATH` 指定。`tests/stub_acp_agent.py` 是一个不调模型的 ACP 桩，ACP 测试走真实的 langgraph-acp 客户端与 stdio 协议。CI（`.github/workflows/ci.yml`）在 Ubuntu 和 Windows 上跑两套测试、校验 `verify.mjs` 与源码一致，并把 wheel 装进干净的 venv、在仓库外的目录跑 `agent --init` / `--verify`。`tests/test_app.py` 按服务端方式调用 `graph.py` 里的图（依赖由输入的 `project_root` 现建，门禁走随包的 `verify.mjs`）。

## 进度

- [x] Day 1：verify.ts + rules.yaml + review-prompt.md
- [x] Day 2：codegraph、codereviewgraph 子图（可单独运行：`:code`、`:fix`）
- [x] Day 3：主图平铺 + REPL + 熔断邮件
- [x] Day 4：MasterGo MCP（已连本机 MasterGo 实测选中图层、变量读取与未选中报错）、ACP 编码后端（权限策略保护门禁文件）、checkpoint 断点恢复、CI
- [x] Electron 视觉验收：`visual` 检查（CDP）。自动化测试用 Edge/Chrome；另用 Electron 45 按 electron-builder 布局（`win-unpacked` + `app.asar`）手工实测过通过、白屏、渲染异常、主进程崩溃四种场景
- [x] 独立 LangGraph 应用：`langgraph.json` + `graph.py`，已用 `langgraph dev` 经 HTTP API 实跑；prompts / 门禁 / 默认配置随包分发，wheel 在仓库外可用
