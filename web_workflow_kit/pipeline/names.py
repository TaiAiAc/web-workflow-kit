"""图与节点的显示名（中文，LangGraph Studio 里看到的就是这些）。

节点名只用于展示和路由；对外契约（输入/状态字段名、status、失败码、图 ID）保持英文不变。
LangGraph 只保留 `|` 和 `:` 两个字符，节点名里不要用它们。
"""

# 主图
CODE = "编码"            # 包住 codegraph：设计稿 → Spec → 写代码
VERIFY = "门禁"          # verify.ts，exit code 是唯一放行依据
REVIEW = "审阅修复"      # 包住 reviewgraph：验收顾问 → 修复
DELIVER = "交付"
BREAKER = "熔断"

# codegraph
DESIGN = "读取设计稿"
SPEC = "生成Spec"
WRITE_CODE = "写代码"

# reviewgraph
ADVISE = "验收审阅"
FIX = "执行修复"

# 图名：既是 Studio 的助手名，也是 langgraph.json 里的图 ID（Studio 的图下拉框显示的是图 ID）。
# 两处必须一致，tests/test_app.py 会校验。API 调用时 assistant_id 直接传这些中文名。
PIPELINE_NAME = "前端交付流水线"
FIX_LOOP_NAME = "门禁修复回环"
CODEGRAPH_NAME = "编码子图"
REVIEWGRAPH_NAME = "审阅修复子图"
