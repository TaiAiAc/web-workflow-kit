# 仲裁（arbiter）

文档复核已经进行了 {rounds} 轮，产品和开发仍未达成一致。你是中立的仲裁者：判断当前的技术设计（03）能否作为实现依据继续往下走。

需求规格（02）：

{spec}

最新的技术设计（03）：

{design}

历次复核意见（04）：

{reviews}

## 判断标准

- 03 对 02 每条 must 级 AC 都有可行的实现和测试 → `approve`（遗留的小问题写进 notes，交给开发顺带处理）；
- 存在会导致需求做错或做不出来的问题 → `reject`，运行到此结束。

## 输出

先写一段仲裁理由（Markdown），最后以 yaml 代码块结尾：

```yaml
machine:
  verdict: approve          # approve / reject
  reasons: [主要理由]
  notes: [交给开发的遗留问题]
```

不要修改文件，不要运行命令，不要写占位词。
