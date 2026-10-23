// LangGraph Studio / API 的入口（langgraph.json 指向这里，`npx @langchain/langgraph-cli dev` 起服务）。
// 依赖按每次运行的输入现建：input.project_root 决定加载哪个项目的 agent.config.json、.env、rules.yaml，
// 改了这些文件下一次运行就生效，不用重启服务。
import { depsFromState } from "./deps.ts"
import { buildCodeGraph, buildMainGraph, buildReviewGraph } from "./graph.ts"
import type { State } from "./state.ts"

const source = (state: State) => depsFromState(state)

/** 前端交付流水线：需求 → 设计稿 → Spec → 写代码 → 门禁 ⇄ 审阅修复 → 交付 / 熔断 */
export const pipeline = buildMainGraph(source, "code")
/** 门禁修复回环：不写新代码，对现有工作区跑门禁，失败则审阅修复 */
export const fix_loop = buildMainGraph(source, "verify")
/** 编码子图（单独调试）：读取设计稿 → 生成 Spec → 写代码，不过门禁 */
export const codegraph = buildCodeGraph(source)
/** 审阅修复子图（单独调试）：输入需带上一轮门禁的失败项 */
export const reviewgraph = buildReviewGraph(source)
