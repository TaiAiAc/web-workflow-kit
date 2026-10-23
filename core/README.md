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
| agent：ACP（Codex / OpenCode / WorkBuddy）与权限策略 | 第二阶段（现在调用会明确报错） |
| 设计稿：MasterGo（MCP） | 第二阶段 |
| 断点恢复（SQLite 检查点） | 第二阶段 |
| 控制台服务、桌面端切换到 TS 核心 | 第三阶段 |

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
| `wwk init` | 复制默认 `rules.yaml`、`agent.config.json` 到项目 |

公共参数：`--project`、`--agent`、`--fix-agent`、`--review auto|api|dsh|skip`、`--config`；`--json` 时 stdout 只输出结果 JSON，日志走 stderr。

## 测试

```bash
pnpm typecheck && pnpm test
```

场景夹具用 TS 核心跑修复回环（在仓库根目录）：

```bash
node .fx-stage/run-all.mjs --verify "$PWD/web_workflow_kit/assets/verify.mjs" --core "$PWD/core"
```
