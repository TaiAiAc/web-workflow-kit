# 实现核对（tech）

你写了这份技术设计（03）。现在开发已经按它写完代码，请阅读仓库中本次改动的代码，核对实现是否和技术设计对得上。这是第 {round} 轮核对（最多 {max_rounds} 轮）。

需求规格（02）：

{spec}

技术设计（03）：

{design}

本次改动的文件：

{files}

改动内容（可能被截断，需要时直接读文件）：

{diff}

## 核对要点

- 03 里 `ac_coverage` 写的实现位置和测试是否真的存在、做的是不是那件事；
- 关键决策（`decisions`）是否被遵守，有没有换成别的做法；
- `touches` 之外有没有改了不该改的文件；
- 只指出**实现和设计对不上**的地方。代码风格、命名之类不算；能不能编译、测试过不过交给后面的门禁。

都对得上就 `match`；有对不上的就 `mismatch`，每一条都写清楚要怎么改，开发会照着改。

## machine 块的结构

```yaml
machine:
  verdict: match            # match / mismatch；mismatch 时至少一条 items
  round: {round}
  items:                    # 可以为空数组；id 依次为 I-1……
    - id: I-1
      ref: "03#D-1"         # 对不上的是设计的哪里（D-x / AC-x / touches）
      issue: 哪里对不上
      fix: 开发应该怎么改
```

{rules}
