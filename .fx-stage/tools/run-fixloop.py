"""跑一次「门禁 ⇄ 审阅/修复」回环（等价于 REPL 的 :fix），打印结果 JSON。

用法：<venv-python> tools/run-fixloop.py scenarios/12-fixloop-pass
退出码：0 交付 / 1 熔断 / 2 用法或环境错误
"""
import json
import os
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("用法：python tools/run-fixloop.py <scenario-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    try:
        from web_workflow_kit.pipeline.config import load_config
        from web_workflow_kit.pipeline.deps import default_deps
        from web_workflow_kit.pipeline.main_graph import run_fix_loop
    except ImportError as e:
        print(f"导入 web_workflow_kit 失败：{e}", file=sys.stderr)
        print("先把 kit 装进这个 Python（pip install -e .），或直接用 kit 自带的 .venv", file=sys.stderr)
        return 2

    # 流水线日志和门禁子进程都写 fd 1，跑的时候整体转到 stderr，stdout 只留结果 JSON 给 run-all.mjs 解析
    sys.stdout.flush()
    saved = os.dup(1)
    os.dup2(2, 1)
    try:
        cfg = load_config(root)
        state = run_fix_loop(default_deps(cfg))
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)
    keep = {k: state.get(k) for k in ("status", "break_reason", "attempt", "verify_exit", "summary")}
    keep["failures"] = [f.get("code") for f in state.get("failures", [])]
    # Windows runner 的 stdout 是 cp1252，中文会编码失败；run-all.mjs 按 UTF-8 读
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(keep, ensure_ascii=False, indent=2))
    return 0 if state.get("status") == "delivered" else 1


if __name__ == "__main__":
    sys.exit(main())