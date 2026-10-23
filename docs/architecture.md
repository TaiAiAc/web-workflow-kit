# 架构

## 分层

```
┌──────────────────────────────────────────────────────────────────┐
│ 入口：agent ui（本地网页控制台）· agent（REPL / 命令行）· langgraph dev │
├──────────────────────────────────────────────────────────────────┤
│ 编排：LangGraph —— 主图 + 编码子图 + 审阅修复子图                   │
├───────────┬───────────┬───────────────┬──────────────┬───────────┤
│ 设计稿     │ Spec       │ 写代码          │ 验收审阅       │ 修复       │
│ MasterGo  │ Claude /   │ Claude / Codex │ DeepSeek API │ DeepSeek  │
│ MCP / json│ GPT        │ OpenCode / dsh │ / dsh / 跳过  │ Harness   │
├───────────┴───────────┴───────────────┴──────────────┴───────────┤
│ 门禁：verify.mjs + rules.yaml（唯一放行权）                          │
├──────────────────────────────────────────────────────────────────┤
│ 通知：smtplib 熔断邮件（24 小时去重）                                │
└──────────────────────────────────────────────────────────────────┘
```

## 图

四张图都在 [web_workflow_kit/graph.py](../web_workflow_kit/graph.py) 导出，节点名集中在 [pipeline/names.py](../web_workflow_kit/pipeline/names.py)。

**前端交付流水线**（主图，[main_graph.py](../web_workflow_kit/pipeline/main_graph.py)）

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

**门禁修复回环**：同一张主图，跳过“编码”，从“门禁”开始。

**编码子图**（[codegraph.py](../web_workflow_kit/pipeline/codegraph.py)）：读取设计稿 → 生成Spec → 写代码。指定了设计稿却读不到时停下，不让 Spec 凭空编。

**审阅修复子图**（[reviewgraph.py](../web_workflow_kit/pipeline/reviewgraph.py)）：验收审阅 → 执行修复。顾问判断需要人来决定（`needs_human`）时不进修复，直接熔断。

### 路由

门禁之后（`route_after_verify`）：

| 条件 | 去向 |
| --- | --- |
| 退出码 0 | 交付 |
| 退出码 2 | 熔断（规则或环境错误） |
| 失败轮数 > `max_retries` | 熔断（修复到上限） |
| 其他 | 审阅修复 |

### 状态

状态定义在 [state.py](../web_workflow_kit/pipeline/state.py)。字段名、`status`（`delivered` / `broken`）、`break_reason`、失败码是机器可读的契约，保持英文；`summary` 是给人看的中文结论。

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

节点不直接创建 agent，而是经 `resolve_deps(source, state)` 取依赖（[deps.py](../web_workflow_kit/pipeline/deps.py)）：

- REPL 和测试传一个固定的 `Deps`；
- 控制台和 LangGraph 服务传一个函数，每次运行按输入里的 `project_root`、`coding_agent`、`review_backend` 现建依赖。所以一个服务能同时服务多个项目，改了项目配置下次运行就生效。

测试用假 agent、假门禁整体替换 `Deps`。

## 原则如何落地

| 原则 | 代码里的保证 |
| --- | --- |
| 门禁唯一 | 路由只看 `verify_exit`；顾问输出里的 `pass` 字段被 `validate_plan` 丢弃；ACP agent 改不了门禁文件 |
| 零 token 优先 | 门禁全绿直接交付，不调审阅；`--verify` 只跑脚本 |
| 硬性熔断 | 失败轮数在“门禁”节点里累加，`> max_retries` 必进熔断；服务端另设递归上限 200 兜底 |
| 模型异构 | 编程 agent、审阅、修复各自可配，默认 Claude 写、DeepSeek 审与修 |
| 输入最小化 | 只传本次改动块（失败点名的文件优先，按字符预算截断，[diffs.py](../web_workflow_kit/pipeline/diffs.py)）；门禁只回传失败项且只留输出尾部；审阅每次只有提示词 + 本轮输入 |
| 多端通用 | 主图不分端，差异全部在 `rules.yaml` |

## 安全

门禁会执行 `rules.yaml` 里的命令，agent 会改代码，所以有几道防线。

**本地控制台**（[ui/server.py](../web_workflow_kit/ui/server.py)）
- 只监听 `127.0.0.1`；只接受 Host 为 `127.0.0.1` / `localhost` 的请求（防 DNS rebinding）。
- 每次启动生成随机令牌，只嵌在本页面里；所有接口（包括弹出文件夹选择窗口）都要带令牌，其他网站无法借你的浏览器触发运行或在桌面上弹窗。
- 只接受 `application/json` 请求（跨站页面能发的“简单请求”会被拒绝），禁止被其他页面嵌入。
- 页面不加载任何外部资源。
- 同一项目同一时间只允许一次运行。

**ACP agent 的权限策略**（[acp_agent.py](../web_workflow_kit/pipeline/acp_agent.py)）：Codex / OpenCode 每次改文件都要经流水线批准。只批准读、搜索、编辑；执行命令一律拒绝；写到项目外或命中受保护路径（`rules.yaml`、`verify/*`、`agent.config.json`、`.agent/*`、`.github/*`、`.env*`）的编辑一律拒绝。

**dsh 审阅的只读校验**（[review.py](../web_workflow_kit/pipeline/review.py)）：审阅前后比对项目文件指纹（跳过 `node_modules`、`dist` 等），顾问改动了任何文件即判违规并熔断，列出被改文件，不自动回滚。

**提示词约束**：编码和修复的提示词明确禁止删测试、`@ts-ignore`、`eslint-disable`、改门禁规则、手改哈希；这些是约束而非硬保证，最终由门禁兜底。

## LangGraph Studio 与 API

仓库根目录的 [langgraph.json](../langgraph.json) 登记了四张图，图 ID 就是中文图名。可以用 LangGraph 的开发服务调试：

```bash
$env:PYTHONUTF8 = '1'; langgraph dev
```

然后打开 `https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024`。

- 需要安装 `[studio]` 可选依赖。
- Studio 页面从 LangChain 网站加载，通常要登录 LangSmith，再由浏览器连本机服务；图仍在本机执行。部分浏览器（包括 Claude 应用的内置浏览器）会拦截网页访问本机地址。日常使用请用 `agent ui`。
- `PYTHONUTF8=1`：langgraph-api 读取自带的 `openapi.json` 时没指定编码，中文 Windows 默认 GBK 会启动失败。
- 通过 HTTP API 运行时，`assistant_id` 直接传中文图名：

  ```json
  { "assistant_id": "门禁修复回环", "input": { "project_root": "D:/projects/my-app" } }
  ```

## 目录

```
langgraph.json                   LangGraph 应用描述：登记 4 张图
web_workflow_kit/                Python 包
  graph.py                       四张图的导出入口
  cli.py                         agent 命令
  ui/server.py                   本地控制台服务
  pipeline/
    main_graph.py                主图、路由、交付与熔断
    codegraph.py / reviewgraph.py  两个子图
    names.py                     图名、节点名、图说明
    state.py                     状态与输入表单（含中文标题）
    deps.py                      依赖注入
    agents.py / acp_agent.py     编程 / 修复 agent 的驱动；ACP 权限策略
    review.py                    验收审阅后端与只读校验
    gate.py                      调用门禁
    diffs.py                     只取本次改动块
    design.py                    设计稿（本地 json / MasterGo MCP）
    notify.py                    熔断邮件与去重
    checkpoint.py                断点恢复
    config.py / llm.py           配置加载；OpenAI 兼容接口客户端
  assets/                        随包分发：默认配置、规则、提示词、verify.mjs、控制台页面
verify/                          门禁源码（TypeScript）与测试
tests/                           Python 测试
```
