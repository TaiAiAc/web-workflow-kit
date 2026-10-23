# web-workflow-kit

本地前端交付流水线：

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
rules.yaml               门禁规则（project_type + 各端 profiles）
verify/verify.ts         门禁脚本，exit 0/1/2
verify/lib/              检查项实现（命令、产物、asar、latest.yml、哈希、包体、冒烟）
prompts/review-prompt.md 验收顾问契约（输入/输出 JSON、失败码表）
prompts/*.md             Spec / 编码 / 修复提示词
scripts/agent_cli.py     REPL 入口（`agent` 命令）
scripts/pipeline/        LangGraph：codegraph、reviewgraph（codereviewgraph）、main_graph
agent.config.json        版本、重试上限、各节点后端
.env.example             SMTP / API Key 模板
```

## 安装

```bash
cd verify && pnpm install
```

```bash
python -m venv .venv
```

```bash
.venv/Scripts/python -m pip install -e .
```

构建后端是 hatchling：setuptools 的 editable 构建会在临时目录里嵌套很深的 egg-info，路径较深的工作区在 Windows 上会超过 260 字符。

可选：`pip install -e .[repl]`（历史记录）、`.[mcp]`（MasterGo 设计稿）、`.[acp]`（ACP，Day 4）。

复制 `.env.example` 为 `.env` 并填写 `DEEPSEEK_API_KEY`、SMTP 配置。

## 使用

只跑门禁（任何项目，零 token）：

```bash
node --import tsx verify/verify.ts --cwd ../my-app --type electron --json
```

REPL：

```bash
agent --project ../my-app
```

| 输入 | 作用 |
| --- | --- |
| 需求原文 | 完整流水线 |
| `:design <ref>` | 下一条需求附带设计稿（本地 `.json`，或开启 MCP 后的 MasterGo 链接） |
| `:code <需求>` | 只跑 codegraph |
| `:verify` | 只跑门禁 |
| `:fix` | 对当前工作区跑门禁 ⇄ 修复闭环 |
| `:status` / `:project <dir>` / `:q` | |

非交互：`agent --project ../my-app --once "需求"`，退出码 0 = 交付，1 = 熔断。

运行产物在目标项目的 `.agent/`：`spec.md`、`verify-report.json`、`fix-task.md`、`delivery.json`、`.notify_cache`。请把 `.agent/` 加进目标项目的 `.gitignore`。

## rules.yaml

- `project_type`：`electron | web | uniapp | miniprogram`，可被 `--type` / `agent.config.json` 的 `verify.type` 覆盖。
- `commands`：各端共用的命令检查；`profiles.<type>.<id>` 同名条目覆盖它。
- 任何带 `run` 的条目都是命令检查，失败码默认 `<ID>_FAIL`，可用 `code:` 指定。
- 内置检查：`artifacts`、`package_size`（小程序主包，自动排除 `subPackages`）、`unpacked`（asar 条目 + 版本）、`installer`（latest.yml 版本与 sha512、可选 SHA256SUMS、文件名含版本）、`smoke`（启动后存活 `alive_ms`）。
- `build` 失败时，依赖产物的检查直接 `skip`，不制造连带失败项。

失败码表见 [prompts/review-prompt.md](prompts/review-prompt.md)，新增失败码时同步更新。

## 测试

```bash
cd verify && pnpm test
```

```bash
python -m unittest discover tests
```

## 进度

- [x] Day 1：verify.ts + rules.yaml + review-prompt.md
- [x] Day 2：codegraph、codereviewgraph 子图（可单独运行：`:code`、`:fix`）
- [x] Day 3：主图平铺 + REPL + 熔断邮件
- [ ] Day 4+：MasterGo MCP 实测（`design.py` 已接 langchain-mcp-adapters，需填 `design.tool`）、ACP 后端（`agents.build_agent` 中 `backend: acp` 预留）、Electron 视觉验收、checkpoint 断点恢复
