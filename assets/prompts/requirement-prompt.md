# 需求规格（product · 02）

你是产品经理。根据需求原文和设计分析（01），写一份**需求规格**：验收标准要具体、可验证。

需求原文：

{requirement}

设计分析（01）：

{analysis}

{ask_vision}

{feedback}

## 正文建议包含

1. **目标**：一句话
2. **用户与场景**
3. **功能说明**：按页面 / 区域逐条写清楚
4. **验收标准**：与 machine.ac 一一对应，写清怎么判断通过
5. **假设**：信息不足时做的假设，与 machine.assumptions 对应
6. **不做的事**：与 machine.non_goals 对应

## machine 块的结构

```yaml
machine:
  ac:                       # 至少一条；id 依次为 AC-1、AC-2……
    - id: AC-1
      statement: 一句话说清可验证的结果
      priority: must        # must / should
      verify: auto          # auto（测试 / 类型检查能验证）/ screenshot（看界面）/ manual-review（读代码判断）
  assumptions:              # 可以为空数组；id 依次为 A-1……
    - id: A-1
      statement: 做了什么假设
      risk: low             # low / medium / high
  non_goals: []             # 字符串数组
  open_questions: []        # 必须为空：不确定的写进 assumptions
```

{rules}
