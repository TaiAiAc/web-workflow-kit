"""交互式 REPL 入口：`agent [--project <dir>]`。"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .pipeline.config import load_config
from .pipeline.deps import default_deps

HELP = """\
直接输入需求       → 跑完整流水线（Spec → 代码 → 门禁 ⇄ 修复 → 交付/熔断）
:design <ref|off>  设置下一次需求使用的设计稿（本地 .json 或 MasterGo 链接）
:code <需求>       只跑 codegraph（Spec + 写代码），不过门禁
:verify            只跑门禁 verify.ts（零 token）
:fix               对当前工作区跑 门禁 ⇄ 审阅/修复 闭环（人工修完后复验也用它）
:project <dir>     切换目标项目
:status            上一次运行结果
:help / :q"""


def _read_line(session: Any) -> str:
    return session.prompt("需求> ") if session else input("需求> ")


def _summary(state: dict[str, Any]) -> str:
    keep = {k: state.get(k) for k in ("status", "break_reason", "attempt", "verify_exit", "history")}
    keep["failures"] = [f"{f.get('code')}: {f.get('message')}" for f in state.get("failures", [])]
    return json.dumps(keep, ensure_ascii=False, indent=2)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="agent", description="前端交付流水线 REPL")
    ap.add_argument("--project", help="目标前端项目目录（默认当前目录）")
    ap.add_argument("--config", help="额外的 agent.config.json")
    ap.add_argument("--once", metavar="需求", help="非交互：跑一次需求后退出，退出码 0=交付 1=熔断")
    args = ap.parse_args(argv)

    from .pipeline.codegraph import build_codegraph
    from .pipeline.main_graph import run_fix_loop, run_pipeline

    cfg = load_config(args.project, args.config)
    deps = default_deps(cfg)

    if args.once:
        state = run_pipeline(deps, args.once)
        print(_summary(state))
        return 0 if state.get("status") == "delivered" else 1

    try:
        from prompt_toolkit import PromptSession
        from prompt_toolkit.history import FileHistory
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        session: Any = PromptSession(history=FileHistory(str(cfg.state_dir / "repl_history")))
    except ImportError:
        session = None

    print(f"agent {cfg['version']} · project={cfg.project_root} · max_retries={cfg.max_retries}  (:help)")
    design_ref: str | None = None
    last: dict[str, Any] = {}
    while True:
        try:
            line = _read_line(session).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not line:
            continue
        cmd, _, arg = line.partition(" ")
        arg = arg.strip()
        try:
            if cmd in (":q", ":quit", ":exit"):
                return 0
            elif cmd == ":help":
                print(HELP)
            elif cmd == ":design":
                design_ref = None if arg in ("", "off") else arg
                print(f"design = {design_ref}")
            elif cmd == ":project":
                cfg = load_config(arg or None, args.config)
                deps = default_deps(cfg)
                print(f"project = {cfg.project_root}")
            elif cmd == ":verify":
                r = deps.gate()
                print("PASS" if r.passed else f"FAIL (exit {r.exit_code})")
                for f in r.failures:
                    print(f"  {f.get('code')}: {f.get('message')}")
            elif cmd == ":fix":
                last = run_fix_loop(deps)
                print(_summary(last))
            elif cmd == ":code":
                if not arg:
                    print("用法：:code <需求>")
                    continue
                last = build_codegraph(deps).invoke({"requirement": arg, "design_ref": design_ref})
                print(f"stop_reason={last.get('code_stop_reason')} break={last.get('break_reason')}")
            elif cmd == ":status":
                print(_summary(last) if last else "(还没有运行记录)")
            elif cmd.startswith(":"):
                print(f"未知命令 {cmd}，:help 查看")
            else:
                last = run_pipeline(deps, line, design_ref)
                print(_summary(last))
                design_ref = None
        except KeyboardInterrupt:
            print("\n(已中断)")
        except Exception as e:  # REPL 不因单次失败退出
            print(f"error: {type(e).__name__}: {e}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
