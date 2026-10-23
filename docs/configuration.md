# 配置参考

流水线的行为由三份配置决定：

| 文件 | 作用 | 位置 |
| --- | --- | --- |
| `agent.config.json` | 流水线怎么跑：重试上限、用哪些 agent、超时、设计稿、审阅…… | 项目根目录（可选，覆盖包内默认值） |
| `rules.yaml` | 门禁检查什么，见 [rules.md](rules.md) | 项目根目录（可选，没有则用包内默认规则） |
| `.env` | 密钥与 SMTP | `~/.web-workflow-kit/.env` 和/或项目根目录 |

用 `agent --project <目录> --init` 把默认的 `agent.config.json`、`rules.yaml` 复制到项目里再改。

## 合并规则

- **`agent.config.json`**：项目里的文件只需写要改的字段，按层级与包内默认值深度合并。例如只想把重试上限改成 5：

  ```json
  { "max_retries": 5 }
  ```

  `agent --config <文件>` 可以额外指定一份配置，代替项目里的那份。
- **`.env`**：先读用户级 `~/.web-workflow-kit/.env`，再读项目根目录的 `.env`，后者覆盖前者；进程环境变量作为最后的兜底。用户级目录可用环境变量 `WWK_HOME` 改位置。
- 每次运行都现读配置：在控制台里改了项目配置，下一次运行就生效，不用重启。

## agent.config.json

### 顶层

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `version` | `"0.2.0"` | 配置版本，仅用于显示 |
| `max_retries` | `3` | 最多自动修复几轮；第 `max_retries + 1` 次门禁仍失败即熔断。必须 ≥ 1 |
| `state_dir` | `".agent"` | 运行产物目录（相对项目根目录） |
| `project_root` | `"."` | 不指定 `--project` 时，相对当前目录的项目位置 |

### verify

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `rules` | `null` | 门禁规则文件路径（相对项目根目录）；`null` 时用项目根目录的 `rules.yaml`，没有则用包内默认 |
| `type` | `null` | 覆盖 `rules.yaml` 里的 `project_type` |
| `timeout_sec` | `3600` | 整个门禁的总超时 |

### diff

验收审阅时只传本次改动块，这里控制大小。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `max_chars` | `12000` | 改动块总字符预算；失败项点名的文件优先，超出预算的块丢弃 |
| `context_lines` | `3` | 每个改动块带几行上下文 |

### design

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否允许从 MasterGo 读取设计稿（本地 `.json` 不受此限制） |
| `max_chars` | `20000` | 设计稿交给 Spec 的字符预算，各工具平分 |
| `tools` | `["get_selection_node", "get_variables"]` | 依次调用的 MasterGo MCP 工具：选中图层、文件变量 |
| `mcp.command` / `mcp.args` | `npx -y @mastergo/vibe-mcp@1.0.31` | 启动 MasterGo MCP 的命令 |
| `mcp.url` | `http://localhost:30678` | 本机 MasterGo 客户端的服务地址；端口被占用时 MasterGo 会换端口，这里跟着改 |
| `mcp.env_keys` | `[]` | 需要从 `.env` 传给 MCP 进程的变量名 |

### spec

生成 Spec 用哪个后端。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `"claude_cli"` | `claude_cli`：用 Claude Code 只读地生成；`openai_compatible`：调 OpenAI 兼容接口（如 GPT） |
| `model` | `null` | 模型名；`claude_cli` 时为空表示用 Claude Code 的默认模型 |
| `timeout_sec` | `600` | 超时 |
| `base_url` / `api_key_env` | — | 仅 `openai_compatible`：接口地址、存放 Key 的变量名（默认 `OPENAI_API_KEY`） |

### code 与 coding_agents

`code.agent` 选默认的编程 agent，每个 agent 的启动方式在 `coding_agents` 里。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `code.agent` | `"claude"` | 默认的编程 agent：`claude` / `codex` / `opencode` / `dsh`；每次运行可在控制台或 `--agent` 改 |
| `code.timeout_sec` | `1800` | 写代码的超时，所有 agent 共用 |

`coding_agents.<名称>` 的字段：

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `label` | 全部 | 控制台下拉框里显示的名字 |
| `backend` | 全部 | `claude_cli` / `acp` / `dsh_cli`（任意命令行 agent） |
| `requires` | 全部 | 用来判断“本机是否已安装”的命令名 |
| `model` / `max_turns` / `permission_mode` | `claude_cli` | 传给 `claude -p` 的模型、最大轮数、权限模式（默认 `acceptEdits`：允许改文件） |
| `agent` | `acp` | ACP agent 名称，`claude` / `codex` 时可省略 `command`，使用内置的适配器 |
| `command` | `acp`、`dsh_cli` | 启动命令；`dsh_cli` 中 `{prompt}` 会替换成“读取任务文件并执行”的一句话 |
| `allow_kinds` | `acp` | 批准的操作类型，默认 `read` / `search` / `think` / `edit` |
| `protected` | `acp` | 禁止编辑的路径，默认 `rules.yaml`、`verify/*`、`agent.config.json`、`.agent/*`、`.github/*`、`.env`、`.env.*` |

新增一个 ACP agent 的例子（项目的 `agent.config.json`）：

```json
{
  "coding_agents": {
    "gemini": { "label": "Gemini CLI", "backend": "acp", "agent": "gemini",
                "command": ["gemini", "--experimental-acp"], "requires": "gemini" }
  },
  "code": { "agent": "gemini" }
}
```

控制台的下拉框只列出包内默认的四个选项；项目里新增的 agent 用命令行 `--agent gemini`，或像上例那样设为 `code.agent` 默认使用。

### review

验收审阅（门禁失败后出修复计划）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `"auto"` | `auto` / `api` / `dsh` / `skip`，见 [README](../README.md#验收审阅) |
| `dsh_command` | `["dsh", "headless", "{prompt}"]` | 用 dsh 审阅时的命令 |
| `base_url` | `https://api.deepseek.com` | API 审阅的接口地址（OpenAI 兼容） |
| `model` | `deepseek-chat` | API 审阅的模型 |
| `api_key_env` | `DEEPSEEK_API_KEY` | 存放 API Key 的变量名 |
| `timeout_sec` | `180` | 超时 |

### fix

修复 agent（按审阅计划和失败项改代码）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `"dsh_cli"` | 字段同 `coding_agents.<名称>`，也可以改成 `claude_cli` 或 `acp` |
| `command` | `["dsh", "headless", "{prompt}"]` | 启动命令 |
| `timeout_sec` | `1800` | 超时 |

### notify 与 checkpoint

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `notify.dedup_hours` | `24` | 同一项目、同一组失败码在这么多小时内只发一封熔断邮件 |
| `checkpoint.enabled` | `true` | 命令行运行时把每个节点后的状态写进 `.agent/checkpoints.sqlite`，供 `:resume`；需安装 `[checkpoint]` |

## .env

| 变量 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | API 方式的验收审阅（可选） |
| `OPENAI_API_KEY` | `spec.backend = openai_compatible` 时（可选） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | 发熔断邮件的 SMTP；端口 465 用 SSL，其他端口用 STARTTLS |
| `NOTIFY_EMAIL` | 熔断邮件收件人 |
| `WWK_HOME` | 用户级配置目录（默认 `~/.web-workflow-kit`），只能设成环境变量 |

不配 SMTP 时熔断照常发生，只是不发邮件，结论里会注明。
