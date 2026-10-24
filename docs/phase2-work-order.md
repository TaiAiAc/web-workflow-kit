# 第二阶段实现纲要（定稿 · 施工单）

> 背景：web-workflow-kit 第二阶段。在现有 TS 核心（`core/src`、控制台、桌面端）上改造，不是重写。第一阶段已完成：需求 → 设计稿 → Spec → 编码 → 门禁 ⇄ 审阅修复 → 交付（PR #1–#13，见 `docs/roadmap.md`）。
>
> 定稿说明：在初稿基础上修正了 4 处矛盾（门禁修复提交、合并预演、squash 校验、`.agent/` 忽略），补齐了轮次、锁、快照脱敏、断点校验等细则，并敲定了开放问题。改动处标 **［定稿］**。
>
> 二次定稿：素材入库、合并落地方式、预演前装依赖、临时 worktree 移出项目、slug 拼音依赖，改动处标 **［二定］**。

## 1. 目标

1. 工作区 = 一个文件夹，先建工作区再跑；
2. 通用工作流配置 + 工作区覆盖（都存软件里，项目内不落工作流配置）；
3. 三种输入（MasterGo / 图片+文字 / 纯文字）收敛为同一条流水线；
4. 作业分支上全自动，**人只在合并弹窗出现一次**。

**非目标**：不 push、不需要 git 凭证、不做节点拖拽编排、不做多人协作、不支持同一目录并行开发、不自动决定合并去向。

## 2. 不可改的决策

- 阶段：`discovery`（取材+需求）→ `tech-design` → `doc-review` ⇄ → `implement` → `gate` ⇄ 修复审阅 → `acceptance`；
- 角色：product / tech / dev / vision / arbiter，agent 可替换，尽量模型异构；
- 流程中禁止向人提问：信息不足写 `assumptions`；`needs_decision` 按 bug 处理。**［定稿］** agent 之间的提问（如 product 向 vision 补问一次）不算向人提问；
- 复核最多 2 轮 → arbiter 仲裁；验收失败按 `return_stage` 重跑，最多 2 轮；超限 = 运行失败；
- **［定稿］轮次上限各管一处**：
  - `doc-review.max_rounds = 2`：文档复核；
  - `acceptance.max_rounds = 2`：验收打回重跑；
  - `limits.max_retries = 3`：门禁 ⇄ 修复审阅回环（每次进入 gate 重新计数）；
  - 校验脚本打回不占任何轮次，但同一文档连续 3 次校验不过 = 运行失败（防死循环）；
- 门禁分 blocking / advisory；blocking 全绿 + 验收通过才可合并；
- 开工前拉作业分支；**［定稿］每阶段每轮一次提交**（门禁修复、验收打回后的重做都各自成一次提交）；
- 默认 squash；**［定稿］合并前在临时 worktree 里的合并结果上复验门禁**（见第 4 节）；成功后删作业分支并记录 hash；
- 失败分支保留最近 3 个；「不合并」保留分支并标待处理；
- 工具永不 push；
- 01/02/03 **及 01 引用的素材**随作业分支入库；04/05/06/manifest/仲裁结论留 `.agent/`；
- 文档 = 正文 + `machine` 块（唯一权威）；
- 阶段提交做路径白名单校验（越界即中止）；
- 现有「验收审阅/验收顾问」改名「修复审阅」，把「验收」留给产品验收。

## 3. 工作区与配置

```
~/.web-workflow-kit/workflow.json         通用工作流配置
~/.web-workflow-kit/workspaces.json       [{path, lastMergeTarget, workflowOverrides}]
```

- 合并语义：对象深合并、数组整体替换、阶段用 map + `order`、`enabled:false` 关阶段；
- 每次运行写生效快照 `.agent/runs/<id>/config.snapshot.json`（含来源）。**［定稿］快照剔除所有密钥**（API Key、SMTP 密码、token），只记录「来自 ~/.web-workflow-kit/.env 的哪个键」；
- 项目里保留 `rules.yaml`、`agent.config.json`；
- 配置可导出/导入（导出同样不含密钥）；文件夹移动后标记失联，提示重新绑定。

```jsonc
// workflow.json 要点
{
  "version": 2,
  "roles": {
    "product": {"agent": "claude"}, "tech": {"agent": "codex"},
    "dev": {"agent": "claude"}, "vision": {"agent": "codex"}, "arbiter": {"agent": "dsh"}
  },
  "vision": {"backend": "codex_acp", "model": null, "timeout_sec": 300},   // 第 0 步结论：走 ACP，codex_cli 为退路
  "stages": {
    "discovery":   {"order": 10, "role": "product"},
    "tech-design": {"order": 20, "role": "tech"},
    "doc-review":  {"order": 30, "role": "product", "max_rounds": 2, "on_exceed": "arbiter"},
    "implement":   {"order": 40, "role": "dev"},
    "gate":        {"order": 50, "kind": "verify", "install_command": "auto"},  // "auto" 按锁文件识别；字符串 = 自定义命令；null = 跳过
    "acceptance":  {"order": 60, "role": "product", "max_rounds": 2}
  },
  "input_modes": {"mastergo": {"intake": "mastergo_mcp"}, "image": {"intake": "vision"}, "text": {"intake": "none"}},
  "git": {"branch_prefix": "wwk/", "merge_method": "squash", "keep_failed_branches": 3},
  "documents": {"repo_dir": "docs/wwk", "schema_version": 1},
  "limits": {"max_retries": 3, "max_doc_lint_failures": 3, "token_budget": 0, "time_budget_sec": 0}
}
```

## 4. Git 流程

**开工**

- **［定稿］加锁**：写 `.agent/lock`（run_id、pid、开始时间）；锁存在且进程还活着 → 拒绝开工；进程已不在 → 视为残留，提示后清除；
- **［定稿］`.agent/` 必须被忽略**：项目 `.gitignore` 未包含 `.agent/` 时，拒绝开工并给出一键修复（追加到 `.gitignore`，作为独立提交落在当前分支，用户确认一次——这是工作区初始化时的一次性操作，不算运行中的人工介入）；
- 记录 base；工作区必须干净（**［定稿］** 检查时排除 `.agent/`；脏则拒绝，不 stash）；
- **［定稿］同一工作区存在 `ready_to_merge` 或 `held` 的运行 → 禁止开工**，提示先「合并 / 不合并 / 作废」；
- 从当前分支拉 `wwk/<yyyyMMdd-HHmm>-<slug>`。**［定稿］slug 规则**：取需求标题，仅保留 `[a-z0-9-]`，中文转拼音首字母，截断到 24 字符；结果为空时用 `run<id>`。**［二定］** 拼音用 `pinyin-pro`（与其他依赖一样放 devDependencies，由 esbuild 打进 `dist`）。

**运行中**

- 每阶段每轮一次提交，提交内容按该阶段路径白名单校验（第 5 节）；
- 提交信息格式：`wwk(<stage>): <摘要> [run <id> round <n>]`。

**收尾（合并预演）［定稿］**

1. 对每个候选目标分支用 `git merge-tree` 预检冲突；
2. 用户在弹窗选定目标后（或默认上次的目标），记下目标分支 head 为 `T0`，建**临时 worktree**：`git worktree add --detach <wt> T0`（**［二定］** `<wt>` = `~/.web-workflow-kit/worktrees/<工作区路径 hash>/<run>`，放在项目外，避免项目的 vitest/tsc/eslint 扫到；detached，目标分支本身不在任何地方被检出）。在 `<wt>` 里 `git merge --squash <作业分支>` 并提交，得到 `S`（父提交 = `T0`）；
3. **［二定］装依赖**：在 `<wt>` 里按锁文件识别包管理器做冻结安装（`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`，`package-lock.json` → `npm ci`，`yarn.lock` → `yarn install --immutable`，`bun.lock(b)` → `bun install --frozen-lockfile`）；`workflow.json` 的 `gate.install_command` 可覆盖，`null` 表示跳过；无 `package.json` 时跳过。安装耗时计入 `time_budget_sec`，安装失败 = 门禁失败（原因写「依赖安装失败」+ 日志尾部）；
4. 在 `<wt>` 里对 `S` 跑门禁；
5. 门禁通过 → 用户点「合并」→ 落地（**［二定］** 方案见下）；
6. 门禁失败 → 不合并，保留作业分支，弹窗显示失败原因，状态 `held`；
7. 无论结果，`git worktree remove --force <wt>`；开工和启动时额外跑一次 `git worktree prune`，清理崩溃残留。

**合并落地［二定］**

1. 拒绝条件：目标分支正在任一 worktree 中被检出（`git worktree list --porcelain` 里有 `branch refs/heads/<target>`）→ 提示「请先在该处切走」，不移动；
   - 运行期间主工作区停在作业分支上，所以「目标 = 原分支」是常见情况，此时原分支未被检出，可以正常落地；
2. 原子移动：`git update-ref -m "wwk: merge run <id>" refs/heads/<target> S T0`。git 只在目标当前值 == `T0` 时才写入，比对和移动是一步完成的，没有「检查后、移动前被别人改了」的窗口；失败（目标已前进）→ 回到预演第 2 步，以新 head 重新预演；
3. 因为 `S` 的父提交就是 `T0`，这一步等价于快进，不产生额外合并提交，也不碰任何工作区。

> 注：初稿是「先合并、失败再回退」。改为预演后，目标分支只在门禁通过且用户确认后才移动一次，崩溃或中断都不会留下坏状态，也不再需要回退逻辑。
> 时序：门禁预演在弹窗出现前按「默认目标」先跑；用户换了目标分支才需要重跑预演，弹窗里显示进度。

**弹窗**：目标分支列表（排除 `wwk/*`，显示领先/落后/远端/冲突预检）、默认上次选择、合并方式（squash 默认）、建议提交信息、`[合并] [不合并]`；关闭可恢复。

**合并成功后［定稿］**

- 校验：目标分支 head == `S`，且 `S` 的 tree == 预演时的 tree（squash 后作业分支 head 不是目标分支的祖先，不能用祖先关系判断）；
- **［二定］顺序**：切回原分支 → 校验 → `git branch -D <作业分支>` → 写 manifest → 释放锁。必须先切走，因为 git 不允许删除当前检出的分支；切回时工作区是干净的（作业分支已全部提交），不会冲突；
- 校验通过才执行 `-D`；这条校验是 `-D` 前唯一的保险，必须有测试覆盖。

**状态机**：`running → ready_to_merge → merged | failed | held`；`held` 可被「作废」转为 `failed`（分支按保留策略处理）。

**断点恢复［定稿］**：恢复前校验当前分支 == manifest 的 `work.branch`、head == 最后一次阶段提交；不一致则拒绝恢复并说明原因，不尝试自动修正。

## 5. 文档契约

**落点**

```
<项目>/docs/wwk/<日期>-<slug>/          01-design-analysis.md 02-requirement-spec.md 03-tech-design.md   # 入库
<项目>/docs/wwk/<日期>-<slug>/assets/   01 引用的素材（MasterGo 导出图、用户上传图）                       # 入库［二定］
<项目>/.agent/stages/<stage>/           04-review-report.md 05-self-test.md 06-acceptance-report.md evidence/ history/
<项目>/.agent/runs/<id>/                config.snapshot.json stages.json manifest.json
<项目>/.agent/arbitration/              <run>-ruling.md
<项目>/.agent/lock
~/.web-workflow-kit/worktrees/<工作区路径 hash>/<run>/   合并预演用的临时 worktree（用完即删，放项目外）［二定］
```

**素材规则［二定］**：只收图片（`png/jpg/jpeg/webp/gif/svg`），单个 ≤ 5 MB，文件名用内容 hash 前 12 位 + 原扩展名（同图去重）；01 的 `machine.assets[].path` 必须指向本目录下真实存在的文件，hash 与文件一致——由校验脚本检查。

**骨架**：front-matter（`stage/owner/status/version/inputs/config_hash/generated_at`）+ 正文 + 末尾 ```yaml machine: {...}```。

```yaml
# 01
machine: {sources: [{type, ref, hash}], assets: [{path, kind, hash, purpose}], open_questions: []}

# 02 —— 主键
machine:
  ac: [{id: AC-1, statement, priority: must|should, verify: auto|screenshot|manual-review}]
  assumptions: [{id: A-1, statement, risk: low|medium|high}]
  non_goals: []
  open_questions: []            # approved 时必须为空

# 03
machine:
  ac_coverage: {AC-1: {impl: 文件#位置, test: 测试#用例}}
  decisions: [{id: D-1, decision, alternatives: [], reason}]
  touches: []
  risk: low|medium|high

# 04
machine: {verdict: approved|rejected, round: 2, items: [{id: R-1, ac_ref, doc_ref, issue, fix_required, severity}]}

# 05
machine: {ac_status: {AC-1: pass}, uncovered: [], deviates_from_design: false}

# 06
machine: {ac_status: {AC-1: pass}, verdict: pass|fail, return_stage: null|discovery|tech-design|implement, evidence: []}
```

**manifest**
```jsonc
{"run_id": 42, "base": {"branch", "hash"}, "work": {"branch", "head"},
 "verify": {"gate", "ac", "on_merged_result"},
 "merge": {"target", "target_head_before", "method", "result_hash", "result_tree",
           "gate_after_merge", "work_branch_deleted", "at"}}
```

**校验脚本（零 token）**：front-matter 完整、schema 合法、AC 覆盖 100%、引用存在、`open_questions` 清零、无占位符；不过自动打回重写，不占复核轮次（但受 `max_doc_lint_failures` 限制）。03 打回用「回应表」对 04 的每条 R-x。

**每阶段提交路径白名单［定稿］**

| 提交来源 | 允许的路径 |
| --- | --- |
| `discovery` | 仅 `docs/wwk/**/{01,02}-*.md`、`docs/wwk/**/assets/*`（**［二定］** 受素材规则约束） |
| `tech-design` | 仅 `docs/wwk/**/03-*.md` |
| `implement` | 仅代码路径；禁止 `docs/wwk/**`、`rules.yaml`、`verify/*`、`agent.config.json`、`.gitignore`、CI 配置 |
| `gate` 的修复回环 | 同 `implement` |
| `acceptance` 打回后的重做 | 按 `return_stage` 对应阶段的白名单 |
| `gate` / `acceptance` 本身 | 不提交（报告只写 `.agent/`） |

## 6. vision（看图）

- 只读，只产出 01（B 模式）和视觉证据描述；不写代码；
- 按图片 hash 缓存 01；product 可提**一次**补充问题；
- 开工预检 codex 可用，否则 B 模式拒绝开工；
- 输出严格按 01 schema，看不清写「不确定」，不脑补。

## 7. 代码改造点（本仓库）

| 改动 | 位置 |
| --- | --- |
| 配置层：用户级通用配置 + 工作区覆盖 + 快照（脱敏） | `core/src/config.ts` |
| 阶段注册表与路由 | 新增 `core/src/workflow.ts`；改 `core/src/graph.ts`、`names.ts` |
| 状态字段 `artifacts`、`stage_status` | `core/src/state.ts` |
| 文档契约、校验、版本历史 | 新增 `core/src/docs.ts` |
| 作业分支、锁、合并预演（项目外临时 worktree + 装依赖）、`update-ref` 原子落地、删除校验 | 新增 `core/src/gitflow.ts` |
| slug 拼音 | `core/package.json` 加 `pinyin-pro` |
| vision 适配（Codex 图片通道） | 新增 `core/src/vision.ts` |
| 断点恢复的分支/head 校验 | 改断点恢复相关代码 |
| 术语改名 + 文档更新 | README、docs、代码注释 |
| 工作区向导、配置页（继承/差异）、时间线、合并弹窗 | `core/src/console/*`、`assets/ui/index.html` |
| 弹窗/通知 | `desktop/` |

## 8. 实施顺序［定稿］

0. **预研（与第 1 步并行，半天内出结论）**：Codex 图片通道——ACP 是否透传 image block；不行就走 CLI 图片参数。结论决定第 5 步的做法；
   - **结论（2026-10-24，codex-cli 0.164.0 / codex-acp 1.13.0 实测）**：两条都通。**第 5 步走 ACP**：
     - 适配器 initialize 声明 `promptCapabilities.image: true`，会把 ACP 的 image 块转成 data URL 交给模型；模型不支持图片时会直接报错，不会悄悄把图丢掉；
     - 能复用 `acp.ts` 现有的启动、超时、杀进程组和权限应答；
     - 接法：`ACPAgent` 增加接收 `ContentBlock[]` 的入口；`session/new` 之后调 `session/set_mode read-only`；`promptCapabilities.image` 不为 true 时退到 CLI；vision 的 allowKinds 只放 `read/search/think`；
     - 注意：codex-acp 的 read-only 模式不是 Codex 原生的只读沙箱，真正兜底的是我们这边的权限应答；
   - CLI 作为退路：`codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never -o <文件> "<prompt>" -i <图片> </dev/null`（prompt 放在 `-i` 前面，否则会被当成图片路径；stdin 必须关掉；超时靠调用方杀进程组）。原生只读沙箱更硬，每次输入 token 约是 ACP 的 1/4（实测 3.5k 对 14.9k）；
1. 配置层（含合并语义测试、快照脱敏测试）——**已完成**：`assets/workflow.json` 默认值；`config.ts` 的 `loadWorkflow` / `resolveWorkflow` / `validateWorkflow` / `writeSnapshot`；`workspaces.ts` 的工作区覆盖、重新绑定、导出导入；控制台每次运行写 `.agent/runs/<id>/config.snapshot.json`。工作流配置在用到时才加载，写坏了不影响控制台启动。遗留给第 2 步：`agent.config.json` 的 `max_retries` 与 `workflow.json` 的 `limits.max_retries` 重复，主图改为配置驱动时以后者为准，并删掉前者；
2. 阶段注册表（主图改为配置驱动，未启用阶段跳过）；
3. 文档契约 + 校验脚本 + 提交路径白名单；
4. 作业分支 / 锁 / 合并预演 / 弹窗，后端 + 前端；
5. vision 适配；
6. 指标与拒绝原因回流（每轮 token、耗时、打回原因，按 agent 汇总）。

## 9. 预研/风险

- Codex 图片通道（ACP vs CLI）——第 0 步已有结论，见第 8 节；
- **codex 写代码时，保护路径可能被绕过（未验证）**：codex-acp 默认是 `agent` 模式，审批交给它自己的 auto_review，只有它认为危险的操作才会来问。现在 `acp.ts` 跑 codex 时没有切换模式，普通编辑可能根本不经过我们的 `requestPermission`，`protected` 路径的限制可能失效。属于第一阶段遗留，需要单独实测并修复；
- MasterGo 物料导出（现只有 `get_selection_node` / `get_variables`）；
- 断点（checkpoint）与新状态字段兼容，以及恢复时的分支校验；
- 多端模板默认值（UniApp / 小程序 / Electron）；
- CodeBuddy（WorkBuddy）遇到被拒权限会结束整轮：新的路径白名单是在提交时校验，agent 写文件时仍可能写到白名单外，需确认这种情况走「中止运行」而不是让 agent 卡死。

## 10. 完成标准

- 三种输入各跑通一次：人只点一次合并、01/02/03 入库、合并后删分支、全程无 push；
- **［定稿］用真实 agent 在演示项目 `wwk-demo-dashboard` 上跑这三次**，不只靠桩测试；
- 越界修改被提交白名单拦下（有测试）；
- 合并预演门禁失败时，目标分支没有被移动（有测试）；
- **［二定］** 预演后目标分支被别人推进时，`update-ref` 拒绝写入并触发重新预演（有测试）；目标分支在别的 worktree 检出时拒绝合并（有测试）；
- squash 合并后的删除校验有测试覆盖；
- 三种输入产出同构 01、同一条流水线；
- 构建、测试、三平台 CI 通过，文档同步更新（README、`docs/roadmap.md` 加入第二阶段）。

## 11. 已敲定的开放问题

1. **旧「待合并」卡与新运行**：同一工作区有 `ready_to_merge` / `held` 的运行时禁止开工，提示「合并 / 不合并 / 作废」，处理后才能开新运行。
2. **验收重跑 2 轮**：先定 2 轮；第 6 步的指标记录打回原因，跑几轮真实数据后再调。
3. **`docs/wwk/` 清理**：不自动删除（已入库，属于项目历史）；最多在控制台提供「按月归档」。

## 12. 开工前的准备

- 演示项目 `wwk-demo-dashboard` 里还有第一阶段 WorkBuddy 未提交的 4 个文件和一个 stash，按新规则会被拒绝开工，先提交或丢弃；
- 演示项目的 `.gitignore` 加上 `.agent/`；
- 如果 DeepSeek Key 还没轮换，先在 DeepSeek 控制台换新 Key，再在设置页更新。
