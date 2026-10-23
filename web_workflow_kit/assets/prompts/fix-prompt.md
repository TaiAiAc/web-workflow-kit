# 修复任务（DeepSeek Harness）

门禁 `verify.ts` 第 {attempt}/{max_attempts} 轮未通过。按下面的修复计划逐条修改代码，然后结束。

约束：

- 只做计划里列出的修改；计划没覆盖的失败项，按失败码和 locations 自行定位最小改动。
- 禁止：删除/跳过测试、`@ts-ignore`、`eslint-disable`、`any` 糊类型、修改 `rules.yaml` 或 `verify/`、手改 latest.yml 哈希。
- 不需要自己判断是否通过，流水线会重新跑门禁。

## 失败项

```json
{failures}
```

## 修复计划（验收顾问输出）

```json
{plan}
```
