# 门禁规则（rules.yaml）

门禁是流水线里**唯一有放行权**的环节：它按 `rules.yaml` 逐项检查项目，用退出码给出结论。

| 退出码 | 含义 | 流水线怎么走 |
| --- | --- | --- |
| `0` | 全部通过 | 交付 |
| `1` | 有检查未通过 | 未到修复上限 → 审阅修复后重跑门禁；到上限 → 熔断 |
| `2` | 规则文件或运行环境有误 | 直接熔断（模型无权也无法修） |

门禁只回传**失败项**，每项只保留输出的尾部（默认 3000 字符），控制交给模型的内容。

规则文件的查找顺序：`agent.config.json` 的 `verify.rules` → 项目根目录的 `rules.yaml` → 包内默认规则。

## 结构

```yaml
version: 1
project_type: web            # electron | web | uniapp | miniprogram

defaults:
  timeout_sec: 900           # 单个命令检查的超时
  max_detail_chars: 3000     # 每个失败项保留的输出尾部
  fail_fast: false           # true：第一项失败后其余全部跳过

commands:                    # 各端共用的检查
  typecheck: { run: pnpm exec vue-tsc --noEmit }
  lint:      { run: pnpm exec eslint . --max-warnings=0 }
  test:      { run: pnpm exec vitest run --passWithNoTests }

profiles:
  web:
    checks: [typecheck, lint, test, build, artifacts]   # 按顺序执行
    build:     { run: pnpm build }
    artifacts: { dir: dist, required: [index.html] }
```

- `profiles.<project_type>.checks` 列出要跑的检查，按顺序执行。
- 每个检查的配置先找 `profiles.<type>.<检查名>`，找不到再找 `commands.<检查名>`。
- 默认 `fail_fast: false`：命令检查全部跑完，一轮就收集齐所有失败项，减少来回修复的轮数。
- **前置失败即跳过**：`build` 失败时，依赖构建产物的检查（`artifacts`、`package_size`、`unpacked`、`installer`、`smoke`、`visual`）直接跳过；`smoke` 失败时跳过 `visual`。避免同一个问题被报成一串连带失败。

默认规则见 [assets/rules.yaml](../assets/rules.yaml)，包含四类项目的完整示例。

## 检查项

### 命令检查（任何带 `run` 的条目）

执行一条 shell 命令，退出码非 0 即失败。会从输出里提取 `文件:行:列` 形式的出错位置，交给审阅和修复。

| 字段 | 说明 |
| --- | --- |
| `run` | 要执行的命令（在项目根目录执行） |
| `cwd` | 可选，相对项目根目录的执行目录 |
| `timeout_sec` | 可选，覆盖 `defaults.timeout_sec` |
| `code` | 可选，失败码；默认 `typecheck` → `TYPECHECK_FAIL`、`lint` → `LINT_FAIL`、`test` → `TEST_FAIL`、`build` → `BUILD_FAIL`，其他检查名 → `<名称大写>_FAIL` |

检查名不限于上面四个，例如加一项样式检查：

```yaml
commands:
  stylelint: { run: pnpm exec stylelint "src/**/*.{vue,css}" }
profiles:
  web:
    checks: [typecheck, lint, stylelint, test, build, artifacts]
```

### artifacts：产物存在

| 字段 | 说明 |
| --- | --- |
| `dir` | 产物目录（默认 `dist`） |
| `required` | 必须存在的文件列表（相对 `dir`） |

### package_size：小程序包体

| 字段 | 说明 |
| --- | --- |
| `dir` | 小程序产物目录 |
| `main_max_kb` | 主包上限；`app.json` 里 `subPackages` / `subpackages` 的 `root` 目录自动排除 |
| `total_max_kb` | 总包上限 |

### unpacked：Electron 解包目录

| 字段 | 说明 |
| --- | --- |
| `dir` | 解包目录（默认 `dist/win-unpacked`） |
| `asar` | asar 路径（相对 `dir`，默认 `resources/app.asar`） |
| `asar_required` | asar 内必须存在的条目 |
| `check_version` | `true` 时校验 asar 内 `package.json` 的版本与项目 `package.json` 一致 |

### installer：安装包与增量升级

| 字段 | 说明 |
| --- | --- |
| `dir` | 安装包所在目录（默认 `dist`） |
| `pattern` | 安装包文件名通配，只支持 `*` 和 `**` |
| `latest_yml` | 可选，如 `latest.yml`：校验其中的版本号、引用文件是否存在、sha512 是否匹配 |
| `sha256_file` | 可选，如 `SHA256SUMS.txt`：逐行 `<哈希>  <文件名>` 校验 |

此外会检查安装包文件名里包含项目 `package.json` 的版本号。

### smoke：冒烟启动

| 字段 | 说明 |
| --- | --- |
| `exe` | 可执行文件路径 |
| `args` | 启动参数 |
| `alive_ms` | 启动后至少存活多久才算通过（默认 3000） |

### visual：视觉验收

Electron 可选项。带 `--remote-debugging-port=0` 启动应用，经 Chrome DevTools Protocol 连上渲染进程检查首屏，纯脚本判定。默认规则里配好了字段但没放进 `checks`，确认应用没有在生产包里禁用远程调试后再加到 `checks` 末尾。

| 字段 | 说明 |
| --- | --- |
| `exe` / `args` | 可执行文件与启动参数 |
| `startup_timeout_ms` | 等应用起来、暴露调试端口并出现页面（默认 30000） |
| `timeout_ms` | 连上之后，等期望条件成立（默认 15000；页面可以异步渲染） |
| `expect_text` | 可见文本里必须出现的字符串 |
| `expect_selector` | 必须存在的 CSS 选择器 |
| `forbid_text` | 不得出现的文字，如 `加载失败` |
| `fail_on_exception` | 渲染进程有未捕获异常即失败（默认 `true`） |
| `screenshot` | 截图保存位置（默认 `.agent/visual.png`），截图只给人看，不参与判定 |
| `port` | 固定调试端口；默认 0，让应用自选端口 |

“白屏”的判定：页面里没有任何**有尺寸的可见元素**（`script`、`style` 等不算），也没有可见文字。真实的白屏通常是一个空的挂载点加一堆脚本，按元素总数算会漏判。

## 失败码

| 失败码 | 含义 | 常见方向 |
| --- | --- | --- |
| `TYPECHECK_FAIL` | 类型检查报错 | 按出错位置修类型 |
| `LINT_FAIL` | lint 未通过 | 按规则修代码 |
| `TEST_FAIL` | 单测失败 | 先判断是实现错还是需求变了 |
| `BUILD_FAIL` | 构建失败 | 缺依赖、条件编译、路径别名 |
| `<名称>_FAIL` | 自定义命令检查失败 | 看输出尾部 |
| `CHECK_TIMEOUT` | 命令超时 | 死循环、测试挂起、误用 watch 模式 |
| `ARTIFACT_MISSING` | 产物缺失 | 输出目录、文件名、打包配置 |
| `ASAR_MISSING_ENTRY` | app.asar 缺条目 | electron-builder 的 `files` / `asarUnpack` |
| `VERSION_MISMATCH` | 版本不一致 | package.json、latest.yml、安装包文件名必须同源 |
| `HASH_MISMATCH` | 哈希不符 | 重新构建，不要手改哈希 |
| `PACKAGE_TOO_LARGE` | 小程序包超限 | 分包、按需引入 |
| `SMOKE_CRASH` | 启动后很快退出 | 主进程异常、preload 路径、原生模块 |
| `VISUAL_UNAVAILABLE` | 连不上渲染进程 | 应用崩溃，或禁用了远程调试 |
| `VISUAL_BLANK` | 白屏 | 入口路径、打包后资源路径、路由 base |
| `VISUAL_MISSING` | 期望的文字/元素没出现 | 页面没渲染到位、接口失败后的空态 |
| `VISUAL_FORBIDDEN` | 出现了禁止的文字 | 看可见文本定位报错位置 |
| `RENDERER_ERROR` | 渲染进程未捕获异常 | 按堆栈修 |
| `CONFIG_ERROR` | 规则文件或环境有误（退出码 2） | 修 `rules.yaml` 或安装 Node |

验收顾问看到的失败码说明在 [review-prompt.md](../assets/prompts/review-prompt.md)；新增失败码时同步更新那张表。

## 单独运行门禁

```bash
agent --project D:/projects/my-app --verify
```

门禁本身是一个单文件 Node 脚本，也可以脱离流水线直接调用（例如放进项目自己的 CI）：

```bash
node <仓库>/assets/verify.mjs --cwd D:/projects/my-app --json
```

| 参数 | 说明 |
| --- | --- |
| `--cwd <目录>` | 被检查的项目 |
| `--rules <文件>` | 指定规则文件 |
| `--type <类型>` | 覆盖 `project_type` |
| `--only a,b` / `--skip a,b` | 只跑 / 跳过某些检查 |
| `--json` | 报告以 JSON 输出到 stdout（日志在 stderr） |
| `--out <文件>` | 报告写入文件 |
