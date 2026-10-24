// 图与节点的显示名（中文；控制台和 LangGraph Studio 里看到的都是这些）。
// 节点名只用于展示和路由；对外契约（输入/状态字段名、status、失败码）保持英文不变。

// 主图
export const CODE = "编码"            // 包住 codegraph：设计稿 → Spec → 写代码
export const VERIFY = "门禁"          // verify.ts，exit code 是唯一放行依据
export const REVIEW = "审阅修复"      // 包住 reviewgraph：修复审阅 → 修复
export const DELIVER = "交付"
export const BREAKER = "熔断"
export const REHEARSE = "合并预演"   // 不是图里的节点：运行结束后在临时 worktree 里对合并结果跑门禁

// 第二阶段新增、尚未实现的阶段（主图里先放跳过节点）
export const DISCOVERY = "取材与需求"
export const TECH_DESIGN = "技术设计"
export const DOC_REVIEW = "文档复核"
export const ACCEPTANCE = "产品验收"

// codegraph
export const DESIGN = "读取设计稿"
export const SPEC = "生成Spec"
export const WRITE_CODE = "写代码"

// reviewgraph
export const ADVISE = "修复审阅"
export const FIX = "执行修复"

export const PIPELINE_NAME = "前端交付流水线"
export const FIX_LOOP_NAME = "门禁修复回环"
export const CODEGRAPH_NAME = "编码子图"
export const REVIEWGRAPH_NAME = "审阅修复子图"
