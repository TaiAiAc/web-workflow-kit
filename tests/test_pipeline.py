"""用假 agent / 假门禁跑通主图与两个子图：python -m unittest discover tests"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from web_workflow_kit.pipeline.agents import END_TURN, ERROR, AgentResult
from web_workflow_kit.pipeline.config import load_config
from web_workflow_kit.pipeline.deps import Deps, validate_plan
from web_workflow_kit.pipeline.diffs import changed_hunks, snapshot, split_hunks
from web_workflow_kit.pipeline.gate import GateResult
from web_workflow_kit.pipeline import names as N
from web_workflow_kit.pipeline.main_graph import build_main_graph, resume, route_after_verify, run_fix_loop, run_pipeline
from web_workflow_kit.pipeline.notify import mark_sent, should_send

FAIL = GateResult(1, [{"code": "TYPECHECK_FAIL", "check": "typecheck", "message": "x", "locations": ["src/a.ts:1"]}])
PASS = GateResult(0, [])


def _force_remove(func, path, _exc):
    # Windows 上 .git/objects 是只读文件，rmtree 需要先去掉只读位
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _remove_tree(path: Path) -> None:
    # Windows 上句柄（sqlite、杀毒扫描）偶尔晚释放一下，WinError 32；重试几次，清理失败不算测试失败
    for _ in range(10):
        try:
            shutil.rmtree(path, onerror=_force_remove)
            return
        except PermissionError:
            time.sleep(0.2)
    shutil.rmtree(path, ignore_errors=True)


def temp_dir(case: unittest.TestCase) -> Path:
    path = Path(tempfile.mkdtemp(prefix="wwk-test-"))
    case.addCleanup(_remove_tree, path)
    return path


class FakeAgent:
    def __init__(self, reason: str = END_TURN):
        self.reason, self.calls = reason, []

    def run(self, prompt: str, cwd: Path) -> AgentResult:
        self.calls.append(prompt)
        return AgentResult(self.reason)


def make_deps(tmp: Path, gates: list[GateResult], plan: dict | None = None,
              coder: FakeAgent | None = None, fixer: FakeAgent | None = None, max_retries: int = 3):
    cfg = load_config(tmp)
    cfg.raw["max_retries"] = max_retries
    seq = iter(gates)
    sent: list[dict] = []
    deps = Deps(
        cfg=cfg,
        design=lambda ref: None,
        spec=lambda req, design: f"spec for {req}",
        coder=coder or FakeAgent(),
        gate=lambda: next(seq),
        reviewer=lambda payload: plan or {"verdict": "fixable", "summary": "s", "fixes": []},
        fixer=fixer or FakeAgent(),
        notifier=lambda state: sent.append(state) or "sent",
        log=lambda _l: None,
    )
    return deps, sent


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = temp_dir(self)
        subprocess.run(["git", "init", "-q"], cwd=self.tmp, check=True)

    def test_green_first_time_delivers_without_review(self):
        fixer = FakeAgent()
        deps, sent = make_deps(self.tmp, [PASS], fixer=fixer)
        s = run_pipeline(deps, "做个登录页")
        self.assertEqual(s["status"], "delivered")
        self.assertEqual(fixer.calls, [])        # 零 token：脚本全绿直接结束
        self.assertEqual(sent, [])
        self.assertTrue((deps.cfg.state_dir / "delivery.json").is_file())

    def test_fail_then_fix_then_pass(self):
        fixer = FakeAgent()
        deps, _ = make_deps(self.tmp, [FAIL, PASS], fixer=fixer)
        s = run_pipeline(deps, "req")
        self.assertEqual(s["status"], "delivered")
        self.assertEqual(len(fixer.calls), 1)
        self.assertIn("TYPECHECK_FAIL", fixer.calls[0])
        self.assertEqual([h["exit"] for h in s["history"]], [1, 0])

    def test_retry_limit_is_enforced_by_code(self):
        fixer = FakeAgent()
        deps, sent = make_deps(self.tmp, [FAIL] * 10, fixer=fixer, max_retries=2)
        s = run_pipeline(deps, "req")
        self.assertEqual(s["status"], "broken")
        self.assertEqual(len(fixer.calls), 2)
        self.assertTrue(s["break_reason"].startswith("RETRY_LIMIT"))
        self.assertEqual(len(sent), 1)

    def test_reviewer_cannot_override_gate(self):
        deps, _ = make_deps(self.tmp, [FAIL, FAIL], plan={"verdict": "fixable", "pass": True, "fixes": []}, max_retries=1)
        self.assertEqual(run_pipeline(deps, "req")["status"], "broken")

    def test_needs_human_breaks_immediately(self):
        fixer = FakeAgent()
        deps, sent = make_deps(self.tmp, [FAIL], plan={"verdict": "needs_human", "summary": "证书", "fixes": []}, fixer=fixer)
        s = run_pipeline(deps, "req")
        self.assertEqual(s["status"], "broken")
        self.assertEqual(fixer.calls, [])
        self.assertEqual(len(sent), 1)

    def test_gate_config_error_breaks(self):
        deps, _ = make_deps(self.tmp, [GateResult(2, [{"code": "CONFIG_ERROR", "check": "rules", "message": "m"}])])
        self.assertEqual(run_pipeline(deps, "req")["break_reason"], "GATE_CONFIG_ERROR")

    def test_design_failure_stops_without_email(self):
        deps, sent = make_deps(self.tmp, [])

        def no_selection(ref):
            raise RuntimeError("MasterGo get_selection_node: ❌ 没有选中图层")

        deps.design = no_selection
        s = run_pipeline(deps, "req", design_ref="mastergo")
        self.assertTrue(s["break_reason"].startswith("DESIGN_ERROR"))
        self.assertNotIn("spec", s)
        self.assertEqual(sent, [])

    def test_code_agent_error_breaks_before_gate(self):
        deps, _ = make_deps(self.tmp, [], coder=FakeAgent(ERROR))
        self.assertTrue(run_pipeline(deps, "req")["break_reason"].startswith("CODE_AGENT_ERROR"))

    def test_fix_loop_skips_codegraph(self):
        coder = FakeAgent()
        deps, _ = make_deps(self.tmp, [FAIL, PASS], coder=coder)
        self.assertEqual(run_fix_loop(deps)["status"], "delivered")
        self.assertEqual(coder.calls, [])

    def test_resume_after_crash_skips_finished_nodes(self):
        coder = FakeAgent()
        calls = iter([RuntimeError("process killed"), PASS])

        def gate():
            r = next(calls)
            if isinstance(r, Exception):
                raise r
            return r

        deps, _ = make_deps(self.tmp, [], coder=coder)
        deps.gate = gate
        with self.assertRaises(RuntimeError):
            run_pipeline(deps, "req")
        s = resume(deps)
        self.assertEqual(s["status"], "delivered")
        self.assertEqual(len(coder.calls), 1)       # codegraph 不会重跑
        self.assertEqual(resume(deps)["status"], "delivered")  # 已结束的线程直接返回

    def test_route(self):
        self.assertEqual(route_after_verify({"verify_exit": 0, "attempt": 9}, 3), N.DELIVER)
        self.assertEqual(route_after_verify({"verify_exit": 1, "attempt": 3}, 3), N.REVIEW)
        self.assertEqual(route_after_verify({"verify_exit": 1, "attempt": 4}, 3), N.BREAKER)

    def test_graph_compiles_both_entries(self):
        deps, _ = make_deps(self.tmp, [])
        build_main_graph(deps)
        build_main_graph(deps, entry="verify")


class UnitTest(unittest.TestCase):
    def test_validate_plan_strips_pass(self):
        self.assertNotIn("pass", validate_plan({"verdict": "fixable", "pass": True}))
        with self.assertRaises(Exception):
            validate_plan({"verdict": "approved"})

    def test_notify_dedup_window(self):
        cache = temp_dir(self) / ".notify_cache"
        self.assertTrue(should_send(cache, "k", 24, now=1000))
        mark_sent(cache, "k", 24, now=1000)
        self.assertFalse(should_send(cache, "k", 24, now=1000 + 3600))
        self.assertTrue(should_send(cache, "k", 24, now=1000 + 24 * 3600))

    def test_hunks_only_changed_blocks(self):
        root = temp_dir(self)
        git = lambda *a: subprocess.run(["git", *a], cwd=root, check=True, capture_output=True)  # noqa: E731
        git("init", "-q")
        (root / "a.ts").write_text("\n".join(f"line{i}" for i in range(100)) + "\n")
        git("add", ".")
        git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
        base = snapshot(root)
        text = (root / "a.ts").read_text().replace("line50", "changed50")
        (root / "a.ts").write_text(text)
        (root / "new.ts").write_text("export {}\n")
        hunks = changed_hunks(root, base, [])
        self.assertEqual({h["file"] for h in hunks}, {"a.ts", "new.ts"})
        self.assertLess(len(next(h for h in hunks if h["file"] == "a.ts")["patch"]), 200)
        self.assertEqual(split_hunks(""), [])


if __name__ == "__main__":
    unittest.main()
