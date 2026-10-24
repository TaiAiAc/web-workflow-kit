# TS 核心（迁移中）

流水线核心的 TypeScript 版本，目标是让桌面端只依赖 Node / Electron，不再需要用户装 Python。行为与 Python 版（`web_workflow_kit/pipeline/`）一一对应：同样的图、节点名、状态字段、熔断原因和日志文案；默认配置、提示词、`verify.mjs` 暂时直接读 `web_workflow_kit/assets/`，迁移完成后再搬。

## 进度

| 模块 | 状态 |
| --- | --- |
| 配置（`agent.config.json` 深合并、用户级 / 项目 `.env`） | ✅ 第一阶段 |
| 门禁（调 `verify.mjs`、逐行日志、超时整树结束） | ✅ 第一阶段 |
| 主图：编码 → 门禁 ⇄ 审阅修复 → 交付 / 熔断，修复上限、熔断说明 | ✅ 第一阶段 |
| 审阅：DeepSeek API / dsh（只读校验）/ 跳过 / 自动 | ✅ 第一阶段 |
| agent：Claude Code CLI、命令行 agent（dsh 等） | ✅ 第一阶段 |
| 熔断邮件（nodemailer，去重窗口） | ✅ 第一阶段 |
| 设计稿：本地 `.json` | ✅ 第一阶段 |
| agent：ACP（Codex / OpenCode / WorkBuddy）与权限策略 | ✅ 第二阶段 |
| 设计稿：MasterGo（MCP） | ✅ 第二阶段 |
| 断点恢复（检查点存 `node:sqlite`） | ✅ 第二阶段 |
| 本地控制台服务（`wwk ui`，接口与 Python 版一致，页面共用） | ✅ 第三阶段 |
| 桌面端改用 TS 核心（Electron 自带的 Node 运行 `wwk.mjs`，不再需要 Python） | ✅ 第三阶段 |

### 第二阶段的实现要点

- **ACP**：用官方 `@agentclientprotocol/sdk`。客户端不声明文件系统和终端能力，agent 自己读写文件，每次写都经 `session/request_permission` 由权限策略应答（只批准读、搜索、思考、编辑；项目外和 `rules.yaml`、`verify/*`、`.agent/*`、`.env*` 等一律拒绝）。Codex / Claude 的内置适配器版本与 Python 版一致，本机装了同名命令（如 `codex-acp`）时不经 npx。
- **ACP 预设可以指定 `model`**：会话开始后经 `session/set_model` 设上（OpenCode 支持）；设不上直接报错，不悄悄用默认模型。
- **空回合判为出错**：有的 agent 模型调用失败（Key 无效、没登录）时仍回 `end_turn`，本轮没有输出、没有工具调用、0 token 时按出错处理并提示检查登录与模型，不让它白白耗掉修复轮数。
- **MasterGo**：用官方 `@modelcontextprotocol/sdk` 直接连 vibe-mcp，只调只读工具；解析、截断与 Python 版一致。
- **检查点**：沿用 LangGraph 的 `MemorySaver` 逻辑，每次写入后把该线程整份存进 `.agent/checkpoints.sqlite`（`node:sqlite`，Electron 自带，不需要原生模块），保留最近 20 个线程。`wwk resume [线程]` 从最后完成的节点继续。

## 用法

需要 Node ≥ 22.18 和 pnpm。

```bash
pnpm install
```

```bash
pnpm cli fix --project /path/to/app
```

| 命令 | 作用 |
| --- | --- |
| `wwk fix` | 对当前工作区跑门禁 ⇄ 审阅修复回环 |
| `wwk verify` | 只跑一次门禁，退出码 0 / 1 / 2 |
| `wwk run "<需求>"` | 完整流水线 |
| `wwk resume [线程]` | 从检查点继续被中断的运行（默认最近一次） |
| `wwk init` | 复制默认 `rules.yaml`、`agent.config.json` 到项目 |
| `wwk ui [--port 8765] [--no-browser]` | 打开本地控制台（桌面端也是起这个） |

公共参数：`--project`、`--agent`、`--fix-agent`、`--review auto|api|dsh|skip`、`--config`；`--json` 时 stdout 只输出结果 JSON，日志走 stderr。

## 测试

```bash
pnpm typecheck && pnpm test
```

打成单文件（桌面端随应用分发的就是它；依赖全部内联，只需要 Node）：

```bash
pnpm build
```

场景夹具用 TS 核心跑修复回环（在仓库根目录）：

```bash
node .fx-stage/run-all.mjs --verify "$PWD/web_workflow_kit/assets/verify.mjs" --core "$PWD/core"
```
