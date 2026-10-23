# 开发

## 环境

需要 Python ≥ 3.10、Node ≥ 22、pnpm。

```bash
python -m venv .venv
```

```bash
.venv/Scripts/python -m pip install -e ".[all]"
```

```bash
cd verify && pnpm install
```

`[all]` 包含 MasterGo、ACP、断点恢复、REPL 历史和 LangGraph Studio 的可选依赖。

## 门禁脚本

门禁源码是 `verify/` 下的 TypeScript，运行时用的是打包产物 `web_workflow_kit/assets/verify.mjs`（esbuild 打成单文件，依赖已内联，只需要 Node）。**改了 `verify/` 下的源码后必须重新打包并提交产物**，CI 会校验两者一致：

```bash
cd verify && pnpm build
```

开发时也可以直接跑源码：

```bash
cd verify && pnpm verify --cwd D:/projects/my-app
```

## 测试

```bash
cd verify && pnpm typecheck && pnpm test
```

```bash
python -m unittest discover tests
```

| 测试 | 覆盖 |
| --- | --- |
| `verify/test/verify.test.ts` | 规则解析、命令检查、超时、产物、asar、latest.yml 与哈希、冒烟、前置失败跳过 |
| `verify/test/visual.test.ts` | 视觉验收：用本机 Edge / Chrome 代替 Electron 走真实的 DevTools 协议；找不到浏览器时跳过，可用 `CHROME_PATH` 指定 |
| `tests/test_pipeline.py` | 主图路由、修复上限、顾问无放行权、断点恢复、改动块提取（假 agent、假门禁） |
| `tests/test_app.py` | `graph.py` 按服务端方式运行（依赖按输入现建，门禁走随包的 `verify.mjs`）、中文图名与表单、CLI |
| `tests/test_ui.py` | 本地控制台：令牌、Host 校验、文件夹选择、真实运行与进度 |
| `tests/test_coding_agents.py` | 四个编程 agent 的构建；所选 agent 真被调用 |
| `tests/test_review.py` | 审阅后端选择、dsh 输出解析、只读违规检测 |
| `tests/test_integrations.py` | ACP 权限策略（经真实的 langgraph-acp 客户端连 `tests/stub_acp_agent.py`）、设计稿解析 |

`tests/stub_acp_agent.py` 是一个不调模型的 ACP 桩：按环境变量申请写文件权限，获批才写，用来验证权限策略和 stop_reason 映射。

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) 在 Ubuntu 和 Windows 上分别：

1. 门禁：类型检查、测试，并重新打包校验 `verify.mjs` 与源码一致；
2. 流水线：安装 `.[checkpoint,acp]` 后跑全部 Python 测试；
3. 打包：构建 wheel，装进干净的虚拟环境，在仓库外的目录运行 `agent --version` / `--init` / `--verify`。

## Windows 上的注意事项

- **控制台编码**：GitHub 的 Windows runner 和部分终端是 cp1252 / GBK。日志和 CLI 输出遇到打不出的字符会替换而不是崩溃；测试里起子进程打印中文时要显式用 UTF-8。
- **路径长度**：构建后端用 hatchling。setuptools 的 editable 构建会在临时目录里嵌套很深的 egg-info，深路径的工作区会超过 260 字符。
- **`npx` 等命令**：Windows 上是 `.cmd` / `.exe`，`asyncio` 和部分库不按 PATHEXT 解析，代码里统一先用 `shutil.which` 解析成完整路径。
- **langgraph dev**：需要 `colorama`（已放进 `[studio]`）和 `PYTHONUTF8=1`。
- **代理**：pip、npx、gh 不读 `.gitconfig` 的代理，需要 `HTTPS_PROXY`。

## 新增内容时要同步的地方

| 新增 | 同步 |
| --- | --- |
| 失败码 | `verify/lib/checks.ts` 的类型、[review-prompt.md](../web_workflow_kit/assets/prompts/review-prompt.md) 的失败码表、[rules.md](rules.md) |
| 检查项 | `verify/lib/checks.ts`、默认 `rules.yaml`、[rules.md](rules.md)，并重新 `pnpm build` |
| 配置字段 | 默认 `agent.config.json`、[configuration.md](configuration.md) |
| 图或节点 | `pipeline/names.py`、`graph.py`、`langgraph.json`（图说明须与 `names.GRAPH_DESCRIPTIONS` 一致，有测试校验）、`ui/server.py` 的 `BUILDERS` |
| 编程 agent | 默认 `agent.config.json` 的 `coding_agents`、`state.py` 的 `CodingAgent` 选项 |
