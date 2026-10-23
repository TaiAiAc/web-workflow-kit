"""LangGraph 应用入口：langgraph.json 里登记的图都从这里导出。

`langgraph dev` / LangGraph Studio 打开后可见四张图，每次运行在输入里给 project_root（目标前端项目的绝对路径），
节点按该项目的 agent.config.json / .env / rules.yaml 现取依赖，所以一个服务可以同时服务多个项目。
检查点由服务端注入，这里编译时不带 checkpointer。
"""
from __future__ import annotations

# 必须用绝对导入：langgraph dev 按文件路径加载本模块，不把它当包内模块，相对导入会失败
from web_workflow_kit.pipeline.codegraph import build_codegraph
from web_workflow_kit.pipeline.deps import deps_from_state
from web_workflow_kit.pipeline.main_graph import build_main_graph
from web_workflow_kit.pipeline.reviewgraph import build_reviewgraph

# 每轮门禁 + 审阅修复约 3 步；真正的上限是代码里的 attempt 计数，这里只给足余量
_LIMITS = {"recursion_limit": 200}

# 需求 → 设计稿 → Spec → 写代码 → 门禁 ⇄ 审阅/修复 → 交付 | 熔断
pipeline = build_main_graph(deps_from_state, entry="code").with_config(_LIMITS)

# 不写新代码：对现有工作区跑 门禁 ⇄ 审阅/修复（人修完后复验也用它）
fix_loop = build_main_graph(deps_from_state, entry="verify").with_config(_LIMITS)

# 两个子图单独调试用
codegraph = build_codegraph(deps_from_state)
reviewgraph = build_reviewgraph(deps_from_state)
