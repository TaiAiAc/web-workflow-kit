# 开发

## 环境

需要 Node ≥ 22.18、pnpm。不需要 Python。

```bash
cd core && pnpm install
```

```bash
cd verify && pnpm install
```

网络需要代理时设置 `HTTPS_PROXY`。pnpm 12 默认不安装发布不到约一天的包，`pnpm run` 等脚本也会做同样的检查；遇到时可以设环境变量 `pnpm_config_minimum_release_age=0`。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `core/` | 流水线核心：图、agent、门禁调用、命令行、本地控制台服务。`pnpm build` 打成单文件 `core/dist/wwk.mjs`（依赖全部内联，只需要 Node），并把 `assets/` 复制到它旁边 |
| `assets/` | 默认 `agent.config.json`、`rules.yaml`、提示词、门禁产物 `verify.mjs`、控制台页面 `ui/index.html` |
| `verify/` | 门禁源码（TypeScript） |
| `desktop/` | 桌面端（Electron），见 [desktop.md](desktop.md) |
| `.fx-stage/` | 场景夹具 |

开发时直接跑源码（在 `core/` 里）：

```bash
pnpm cli fix --project /path/to/app
```

```bash
pnpm cli ui
```

`core/` 的模块说明见 [core/README.md](../core/README.md)。

## 门禁脚本

门禁源码是 `verify/` 下的 TypeScript，运行时用的是打包产物 `assets/verify.mjs`（esbuild 打成单文件，依赖已内联，只需要 Node）。**改了 `verify/` 下的源码后必须重新打包并提交产物**，CI 会校验两者一致：

```bash
cd verify && pnpm build
```

开发时也可以直接跑源码：

```bash
cd verify && pnpm verify --cwd D:/projects/my-app
```

## 测试

```bash
cd core && pnpm typecheck && pnpm test
```

```bash
cd verify && pnpm typecheck && pnpm test
```

| 测试 | 覆盖 |
| --- | --- |
| `verify/test/verify.test.ts` | 规则解析、命令检查、超时、产物、asar、latest.yml 与哈希、冒烟、前置失败跳过 |
| `verify/test/visual.test.ts` | 视觉验收：用本机 Edge / Chrome 代替 Electron 走真实的 DevTools 协议；找不到浏览器时跳过，可用 `CHROME_PATH` 指定 |
| `core/test/pipeline.test.ts` | 主图路由、修复上限、顾问无放行权、断点恢复、改动块提取（假 agent、假门禁） |
| `core/test/review.test.ts` | 审阅后端选择、dsh 输出解析、只读违规检测 |
| `core/test/acp.test.ts` | ACP 权限策略、stop_reason 映射、空回合判错（连 `test/fixtures/stub-acp-agent.mjs`） |
| `core/test/design.test.ts` | 设计稿：本地 json、MasterGo（连 `test/fixtures/stub-mastergo-mcp.mjs`） |
| `core/test/config.test.ts` | 配置深合并、`.env` 优先级；各 agent 的构建与可用性 |
| `core/test/console.test.ts` | 本地控制台：令牌、Host 校验、生成配置、工作空间、真实运行与进度、运行记录落盘 |
| `core/test/settings.test.ts` | 设置页：`.env` 读写与打码、agent 登录状态、终端登录命令、连通性探测 |
| `core/test/cli.test.ts` | 命令行：`--version` / `--help`、退出码、交互模式 |

场景夹具在 `.fx-stage/`：18 个场景覆盖 web / 小程序 / Electron 门禁的通过与各类失败、规则错误，以及修复回环的交付、重试熔断和配置熔断。一键跑全部（默认用仓库的 `assets/verify.mjs` 和 `core/`；`core/` 没装依赖时跳过修复回环场景）：

```bash
node .fx-stage/run-all.mjs
```

只跑部分场景加 `--only 02,16`，看失败时的完整输出加 `--verbose`。场景素材由 `.fx-stage/tools/gen-scenarios.mjs` 生成，改期望要改生成器再重跑它，不要手改 `expected.json`。跑完后 `16-fixloop-pass/public/index.html` 会被删掉，用 `git checkout -- .fx-stage` 还原。

`core/test/fixtures/stub-acp-agent.mjs` 是一个不调模型的 ACP 桩：按环境变量申请写文件权限，获批才写，用来验证权限策略和 stop_reason 映射。

## 打包与安装

```bash
cd core && pnpm build
```

```bash
cd core && npm install -g .
```

装好后在任何目录都能用 `wwk`。`npm pack` 打出的包只含 `dist/`（`wwk.mjs` + `assets/`），没有运行时依赖。桌面端的打包见 [desktop.md](desktop.md)。

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) 在 Ubuntu、Windows 和 macOS 上分别：

1. 门禁：类型检查、测试，并重新打包校验 `assets/verify.mjs` 与源码一致；
2. 核心：类型检查、测试、打包并运行 `wwk.mjs --help`，再用核心跑 `.fx-stage` 的全部场景；
3. 安装：`npm pack` 打包，装进临时目录，在仓库外运行 `wwk --version` / `init` / `verify`。

## Windows 上的注意事项

- **控制台编码**：GitHub 的 Windows runner 和部分终端是 cp1252 / GBK；测试里起子进程打印中文时要显式用 UTF-8。
- **`npx` 等命令**：Windows 上是 `.cmd` / `.exe`，`spawn` 不按 PATHEXT 解析，代码里统一先用 `which`（[proc.ts](../core/src/proc.ts)）解析成完整路径。
- **环境变量大小写**：Windows 上是 `Path` 不是 `PATH`，测试里改 PATH 时两个都要考虑。
- **临时目录**：子进程退出后文件句柄可能还没释放，删临时目录要重试（EBUSY）。
- **代理**：npx、gh 不读 `.gitconfig` 的代理，需要 `HTTPS_PROXY`。

## 新增内容时要同步的地方

| 新增 | 同步 |
| --- | --- |
| 失败码 | `verify/lib/checks.ts` 的类型、[review-prompt.md](../assets/prompts/review-prompt.md) 的失败码表、[rules.md](rules.md) |
| 检查项 | `verify/lib/checks.ts`、默认 `rules.yaml`、[rules.md](rules.md)，并重新 `pnpm build` |
| 配置字段 | 默认 `agent.config.json`、[configuration.md](configuration.md) |
| 图或节点 | `core/src/names.ts`、`graph.ts`、`studio.ts`、[langgraph.json](../langgraph.json)、`console/server.ts` 的图列表 |
| 编程 agent | 默认 `agent.config.json` 的 `coding_agents`；需要登录的还要加进 `console/settings.ts` 的 `AGENTS` |
| 设置项 | `console/settings.ts` 的 `CATALOG`、[.env.example](../.env.example)、[configuration.md](configuration.md) |
