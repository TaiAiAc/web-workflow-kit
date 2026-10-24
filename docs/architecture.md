# 架构

## 分层

```
┌──────────────────────────────────────────────────────────────────┐
│ 入口：桌面端 · wwk ui（本地网页控制台）· wwk（交互模式 / 命令行）· Studio │
├──────────────────────────────────────────────────────────────────┤
│ 编排：LangGraph —— 主图 + 编码子图 + 审阅修复子图                   │
├───────────┬───────────┬───────────────┬──────────────┬───────────┤
│ 设计稿     │ Spec       │ 写代码          │ 验收审阅       │ 修复       │
│ MasterGo  │ Claude /   │ Claude / Codex │ DeepSeek API │ DeepSeek  │
│ MCP / json│ GPT        │ OpenCode / dsh │ / dsh / 跳过  │ Harness   │
├───────────┴───────────┴───────────────┴──────────────┴───────────┤
│ 门禁：verify.mjs + rules.yaml（唯一放行权）                          │
├──────────────────────────────────────────────────────────────────┤
│ 通知：nodemailer 熔断邮件（24 小时去重）                             │
└──────────────────────────────────────────────────────────────────┘
```

## 图

四张图都在 [core/src/graph.ts](../core/src/graph.ts) 里构建（LangGraph JS），节点名集中在 [names.ts](../core/src/names.ts)。

**前端交付流水线**（主图，`buildMainGraph`）

```
开始 → 编码 → 门禁 ─┬→ 交付 → 结束
                ▲  ├→ 审阅修复 ─┐
                └──┼───────────┘
                   └→ 熔断 → 结束          （编码出错也直接进熔断）
```

| 节点 | 做什么 |
| --- | --- |
| 编码 | 调用编码子图：读取设计稿 → 生成Spec → 写代码 |
| 门禁 | 运行门禁脚本，记录退出码和失败项；失败则失败轮数 +1 |
| 审阅修复 | 调用审阅修复子图：验收审阅 → 执行修复 |
| 交付 | 写 `.agent/delivery.json`，给出中文结论；不提交代码 |
| 熔断 | 发邮件（去重）、给出中文结论，等人介入 |

**门禁修复回环**：同一张主图，跳过“编码”，从“门禁”开始（这时图里不加“编码”节点）。

**编码子图**（`buildCodeGraph`）：读取设计稿 → 生成Spec → 写代码。指定了设计稿却读不到时停下，不让 Spec 凭空编。

**审阅修复子图**（`buildReviewGraph`）：验收审阅 → 执行修复。顾问判断需要人来决定（`needs_human`）时不进修复，直接熔断。

### 路由

门禁之后（`routeAfterVerify`）：

| 条件 | 去向 |
| --- | --- |
| 退出码 0 | 交付 |
| 退出码 2 | 熔断（规则或环境错误） |
| 失败轮数 > `limits.max_retries` | 熔断（修复到上限） |
| 其他 | 审阅修复 |

### 状态

状态定义在 [state.ts](../core/src/state.ts)。字段名、`status`（`delivered` / `broken`）、`break_reason`、失败码是机器可读的契约，保持英文；`summary` 是给人看的中文结论。

| 字段 | 说明 |
| --- | --- |
| `project_root` / `requirement` / `design_ref` | 输入 |
| `coding_agent` / `review_backend` | 输入：本次运行选的编程 agent、审阅方式 |
| `spec` / `baseline` | 生成的 Spec；编码前的工作区快照（只取本次改动块用） |
| `verify_exit` / `failures` / `attempt` | 最近一次门禁的退出码、失败项、累计失败轮数 |
| `plan` | 验收顾问的修复计划（含 `reviewer`：经由哪个后端） |
| `status` / `break_reason` / `summary` | 结果 |
| `history` | 每轮门禁的结果 |

### 依赖注入

节点不直接创建 agent，而是从 `source` 取依赖（[deps.ts](../core/src/deps.ts)）：

- 命令行、交互模式和测试传一个固定的 `Deps`；
- 控制台和 LangGraph Studio 传 `depsFromState`传一个函数，每次运行按输入里的 `project_root`、`coding_agent`、`review_backend` 现建依赖。所以一个服务能同时服务多个项目，改了项目配置下次运行就生效。

测试用假 agent、假门禁整体替换 `Deps`。

## 原则如何落地

| 原则 | 代码里的保证 |
| --- | --- |
| 门禁唯一 | 路由只看 `verify_exit`；顾问输出里的 `pass` 字段被 `validatePlan` 丢弃；ACP agent 改不了门禁文件 |
| 零 token 优先 | 门禁全绿直接交付，不调审阅；`wwk verify` 只跑脚本 |
| 硬性熔断 | 失败轮数在“门禁”节点里累加，`> limits.max_retries` 必进熔断；图另设递归上限兜底 |
| 模型异构 | 编程 agent、审阅、修复各自可配，默认 Claude 写、DeepSeek 审与修 |
| 输入最小化 | 只传本次改动块（失败点名的文件优先，按字符预算截断，[diffs.ts](../core/src/diffs.ts)）；门禁只回传失败项且只留输出尾部；审阅每次只有提示词 + 本轮输入 |
| 多端通用 | 主图不分端，差异全部在 `rules.yaml` |

## 安全

门禁会执行 `rules.yaml` 里的命令，agent 会改代码，所以有几道防线。

**本地控制台**（[console/server.ts](../core/src/console/server.ts)）
- 只监听 `127.0.0.1`；只接受 Host 为 `127.0.0.1` / `localhost` 的请求（防 DNS rebinding）。
- 每次启动生成随机令牌，只嵌在本页面里；所有接口（包括弹出文件夹选择窗口）都要带令牌，其他网站无法借你的浏览器触发运行或在桌面上弹窗。
- 只接受 `application/json` 请求（跨站页面能发的“简单请求”会被拒绝），禁止被其他页面嵌入。
- 页面不加载任何外部资源。
- 同一项目同一时间只允许一次运行。
- 「打开目录」「移除」「设置 agent」以及设置页读写项目 `.env` 只作用于已加入工作空间的目录，不能借接口打开任意路径。
- 设置页的密钥只写不读：接口只返回打码后的值；`.env` 写入时保留其他行，权限设为 600；只接受固定目录里的变量名，值里不能有换行。

**ACP agent 的权限策略**（[acp.ts](../core/src/acp.ts)）：Codex / OpenCode / WorkBuddy 每次改文件都要经流水线批准。只批准读、搜索、思考、编辑；执行命令一律拒绝；写到项目外或命中受保护路径（`rules.yaml`、`verify/*`、`agent.config.json`、`.agent/*`、`.github/*`、`.env*`）的编辑一律拒绝。

**dsh 审阅的只读校验**（[review.ts](../core/src/review.ts)）：审阅前后比对项目文件指纹（跳过 `node_modules`、`dist` 等），顾问改动了任何文件即判违规并熔断，列出被改文件，不自动回滚。

**提示词约束**：编码和修复的提示词明确禁止删测试、`@ts-ignore`、`eslint-disable`、改门禁规则、手改哈希；这些是约束而非硬保证，最终由门禁兜底。

## LangGraph Studio 与 API

仓库根目录的 [langgraph.json](../langgraph.json) 登记了四张图（入口是 [core/src/studio.ts](../core/src/studio.ts)），图 ID 就是中文图名。先在 `core/` 里 `pnpm install`，再在仓库根目录用 LangGraph 的 JS 开发服务调试：

```bash
npx @langchain/langgraph-cli dev
```

然后打开 `https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024`。

- Studio 页面从 LangChain 网站加载，通常要登录 LangSmith，再由浏览器连本机服务；图仍在本机执行。部分浏览器（包括 Claude 应用的内置浏览器）会拦截网页访问本机地址。日常使用请用桌面端或 `wwk ui`。
- 通过 HTTP API 运行时，`assistant_id` 直接传中文图名：

  ```json
  { "assistant_id": "门禁修复回环", "input": { "project_root": "D:/projects/my-app" } }
  ```

## 目录

```
langgraph.json                   LangGraph 应用描述：登记 4 张图
assets/                          默认配置、规则、提示词、verify.mjs、控制台页面（打包时复制进 core/dist）
core/                            流水线核心（TypeScript），打包成单文件 dist/wwk.mjs
  src/
    cli.ts / repl.ts             wwk 命令与交互模式
    studio.ts                    给 LangGraph Studio 导出四张图
    graph.ts                     主图、两个子图、路由、交付与熔断、断点恢复
    names.ts                     图名、节点名
    state.ts                     状态
    deps.ts                      依赖注入、提示词拼装
    agents.ts / acp.ts           编程 / 修复 agent 的驱动；ACP 权限策略
    review.ts                    验收审阅后端与只读校验
    gate.ts                      调用门禁
    diffs.ts                     只取本次改动块
    design.ts                    设计稿（本地 json / MasterGo MCP）
    notify.ts                    熔断邮件与去重
    checkpoint.ts                断点（node:sqlite）
    config.ts / llm.ts           配置加载；OpenAI 兼容接口客户端
    console/server.ts            本地控制台服务
    console/workspaces.ts        工作空间列表、各项目的 agent 选择、运行记录落盘
    console/settings.ts          设置页：.env 读写、agent 登录状态、连通性检测
    console/pickers.ts           系统文件夹 / 文件选择窗口
  test/                          测试
verify/                          门禁源码（TypeScript）与测试
desktop/                         桌面端（Electron）
.fx-stage/                       场景夹具
```
