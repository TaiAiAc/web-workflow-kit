# 核心（core）

流水线核心：LangGraph JS 编排的图、各 agent 的驱动、门禁调用、`wwk` 命令行与交互模式、本地控制台服务。`pnpm build` 打成单文件 `dist/wwk.mjs`（依赖全部内联，只需要 Node），默认配置、提示词、`verify.mjs`、控制台页面从仓库根目录的 `assets/` 复制到 `dist/assets/`。桌面端随应用分发的就是 `dist/`。

## 模块

| 文件 | 内容 |
| --- | --- |
| `cli.ts` / `repl.ts` | `wwk` 命令；不带命令时进交互模式 |
| `graph.ts` / `names.ts` / `state.ts` | 主图、编码子图、审阅修复子图、路由、交付与熔断、断点恢复 |
| `studio.ts` | 给 LangGraph Studio 导出四张图（见仓库根目录的 `langgraph.json`） |
| `deps.ts` | 依赖注入；编码 / 修复提示词拼装；顾问计划校验 |
| `agents.ts` / `acp.ts` | Claude Code CLI、命令行 agent（dsh 等）、ACP agent（Codex / OpenCode / WorkBuddy）与权限策略 |
| `review.ts` | 验收审阅：DeepSeek API / dsh（只读校验）/ 跳过 / 自动 |
| `gate.ts` | 调 `verify.mjs`，逐行日志，超时整树结束；本机没有 `node` 时用 Electron 自带的 Node |
| `design.ts` | 设计稿：本地 `.json`、MasterGo（MCP） |
| `checkpoint.ts` | 断点：`node:sqlite` |
| `notify.ts` | 熔断邮件（nodemailer，去重窗口） |
| `config.ts` / `llm.ts` | 配置深合并、用户级 / 项目 `.env`；OpenAI 兼容接口客户端 |
| `console/` | 本地控制台服务、工作空间、设置页后端、系统文件选择窗口 |

## 实现要点

- **ACP**：用官方 `@agentclientprotocol/sdk`。客户端不声明文件系统和终端能力，agent 自己读写文件，每次写都经 `session/request_permission` 由权限策略应答（只批准读、搜索、思考、编辑；项目外和 `rules.yaml`、`verify/*`、`.agent/*`、`.env*` 等一律拒绝）。Codex / Claude 的适配器版本固定在 `acp.ts` 的 `DEFAULT_COMMANDS`，本机装了同名命令（如 `codex-acp`）时不经 npx。
- **ACP 预设可以指定 `model`**：会话开始后经 `session/set_model` 设上（OpenCode 支持）；设不上直接报错，不悄悄用默认模型。
- **空回合判为出错**：有的 agent 模型调用失败（Key 无效、没登录）时仍回 `end_turn`，本轮没有输出、没有工具调用、0 token 时按出错处理并提示检查登录与模型，不让它白白耗掉修复轮数。
- **MasterGo**：用官方 `@modelcontextprotocol/sdk` 直接连 vibe-mcp，只调只读工具。
- **检查点**：沿用 LangGraph 的 `MemorySaver` 逻辑，每次写入后把该线程整份存进 `.agent/checkpoints.sqlite`（`node:sqlite`，Electron 自带，不需要原生模块），保留最近 20 个线程。`wwk resume [线程]` 从最后完成的节点继续。
- **资源目录**：`config.ts` 的 `ASSETS_DIR` 先找 `wwk.mjs` 旁边的 `assets/`（打包后），找不到再用仓库根目录的 `assets/`（跑源码时）；也可以用环境变量 `WWK_ASSETS` 指定。

## 用法

需要 Node ≥ 22.18 和 pnpm。

```bash
pnpm install
```

```bash
pnpm cli fix --project /path/to/app
```

命令和参数见仓库 [README](../README.md#命令行)。

## 测试与打包

```bash
pnpm typecheck && pnpm test
```

```bash
pnpm build
```

场景夹具用核心跑修复回环（在仓库根目录）：

```bash
node .fx-stage/run-all.mjs
```
