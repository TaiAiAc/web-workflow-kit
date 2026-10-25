# 核心（core）

流水线核心：LangGraph JS 编排的图、各 agent 的驱动、门禁调用、`wwk` 命令行与交互模式、本地控制台服务。`pnpm build` 打成单文件 `dist/wwk.mjs`（依赖全部内联，只需要 Node），默认配置、提示词、`verify.mjs`、控制台页面从仓库根目录的 `assets/` 复制到 `dist/assets/`。桌面端随应用分发的就是 `dist/`。

## 模块

| 文件 | 内容 |
| --- | --- |
| `cli.ts` / `repl.ts` | `wwk` 命令；不带命令时进交互模式 |
| `graph.ts` / `names.ts` / `state.ts` | 主图、编码子图、审阅修复子图、路由、交付与熔断、断点恢复 |
| `studio.ts` | 给 LangGraph Studio 导出四张图（见仓库根目录的 `langgraph.json`） |
| `deps.ts` | 依赖注入；编码 / 修复提示词拼装；顾问计划校验 |
| `agents.ts` / `agent-options.ts` / `acp.ts` | Claude Code CLI、命令行 agent（dsh 等）、ACP agent（Codex / OpenCode / WorkBuddy）、权限策略与模型/思考强度能力 |
| `review.ts` | 修复审阅：DeepSeek API / dsh（只读校验）/ 跳过 / 自动 |
| `gate.ts` | 调 `verify.mjs`，逐行日志，超时整树结束；本机没有 `node` 时用 Electron 自带的 Node |
| `design.ts` | 设计稿：本地 `.json`、MasterGo（MCP） |
| `checkpoint.ts` | 断点：`node:sqlite` |
| `notify.ts` | 熔断邮件（nodemailer，去重窗口） |
| `config.ts` / `llm.ts` | 配置深合并、用户级 / 项目 `.env`、工作流配置三层合并与校验、脱敏快照；OpenAI 兼容接口客户端 |
| `workflow.ts` | 阶段注册表：七个阶段、节点名、按配置排出本次要走的阶段 |
| `stages.ts` | 文档阶段：取材与需求、技术设计、文档复核（含仲裁）、产品验收；角色 agent、校验重写、05 自测 |
| `docs.ts` | 文档契约：解析、逐份 schema 与跨文档校验、素材、版本历史 |
| `whitelist.ts` | 阶段提交的路径白名单 |
| `gitflow.ts` | 作业分支：开工检查、锁、阶段提交、合并预演（临时 worktree）、落地、删除校验 |
| `vision.ts` | 看图写 01：codex ACP 图片块，CLI 退路，结果缓存 |
| `metrics.ts` | 指标：agent 调用的耗时与 token、打回原因，按 agent 汇总 |
| `console/` | 本地控制台服务、工作空间、设置页后端、系统文件选择窗口 |

## 实现要点

- **ACP**：用官方 `@agentclientprotocol/sdk`。客户端不声明文件系统和终端能力，agent 自己读写文件，每次写都经 `session/request_permission` 由权限策略应答（只批准读、搜索、思考、编辑；项目外和 `rules.yaml`、`verify/*`、`.agent/*`、`.env*` 等一律拒绝）。Codex / Claude 的适配器版本固定在 `acp.ts` 的 `DEFAULT_COMMANDS`，本机装了同名命令（如 `codex-acp`）时不经 npx。
- **ACP 会话配置**：`session/new` 的 `configOptions` 报告模型与思考强度；Codex 用 `session/set_config_option` 在会话内应用，OpenCode 用 `session/set_model`，不支持的项目直接报错。读取能力只建空会话，不发 prompt。
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
