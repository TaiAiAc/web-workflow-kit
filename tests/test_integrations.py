"""ACP 后端、设计稿解析、断点相关的单元/集成测试。"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from scripts.pipeline.acp_agent import DEFAULT_ALLOW_KINDS, DEFAULT_PROTECTED, ACPAgent, is_allowed, map_stop_reason
from scripts.pipeline.agents import END_TURN, ERROR, MAX_TOKENS
from scripts.pipeline.design import _clip_each, _decode
from tests.test_pipeline import temp_dir

STUB = str(Path(__file__).with_name("stub_acp_agent.py"))


def _has_acp() -> bool:
    try:
        import langgraph_acp  # noqa: F401
        return True
    except ImportError:
        return False


class PermissionPolicyTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir(self)

    def check(self, kind, *paths):
        call = {"kind": kind, "locations": [{"path": str(self.root / p)} for p in paths]}
        return is_allowed(call, self.root, DEFAULT_ALLOW_KINDS, DEFAULT_PROTECTED)[0]

    def test_source_edits_allowed(self):
        self.assertTrue(self.check("edit", "src/App.vue"))
        self.assertTrue(self.check("read", "rules.yaml"))  # 读门禁规则可以

    def test_gate_files_protected(self):
        for p in ("rules.yaml", "verify/verify.ts", "agent.config.json", ".agent/spec.md", ".github/workflows/ci.yml", ".env"):
            self.assertFalse(self.check("edit", p), p)

    def test_outside_project_and_execute_denied(self):
        self.assertFalse(self.check("edit", "../elsewhere.ts"))
        self.assertFalse(self.check("execute"))
        self.assertFalse(is_allowed({"kind": "edit"}, self.root, DEFAULT_ALLOW_KINDS, DEFAULT_PROTECTED)[0])

    def test_stop_reason_map(self):
        self.assertEqual(map_stop_reason("end_turn"), END_TURN)
        self.assertEqual(map_stop_reason("max_turn_requests"), MAX_TOKENS)
        for r in ("refusal", "cancelled", None):
            self.assertEqual(map_stop_reason(r), ERROR)


@unittest.skipUnless(_has_acp(), "langgraph-acp not installed (pip install .[acp])")
class ACPAgentStubTest(unittest.TestCase):
    """走真实的 langgraph-acp 客户端和 stdio 协议，对端是 tests/stub_acp_agent.py。"""

    def run_stub(self, writes: str, stop: str = "end_turn"):
        root = temp_dir(self)
        agent = ACPAgent("stub", [sys.executable, STUB], timeout_sec=60)
        with mock.patch.dict(os.environ, {"STUB_WRITES": writes, "STUB_STOP": stop}):
            return root, agent.run("do it", root)

    def test_policy_enforced_over_real_protocol(self):
        root, r = self.run_stub("src/a.ts;rules.yaml;verify/verify.ts;../outside.txt")
        self.assertEqual(r.stop_reason, END_TURN)
        self.assertTrue((root / "src/a.ts").is_file())
        self.assertFalse((root / "rules.yaml").exists())
        self.assertFalse((root / "verify/verify.ts").exists())
        self.assertFalse((root.parent / "outside.txt").exists())
        self.assertIn("protected path: rules.yaml", r.text)
        self.assertIn("write outside project", r.text)

    def test_refusal_maps_to_error(self):
        _, r = self.run_stub("", stop="refusal")
        self.assertEqual(r.stop_reason, ERROR)

    def test_unreachable_agent_is_error_not_crash(self):
        r = ACPAgent("stub", [str(Path(STUB).with_name("no_such_binary.exe"))], timeout_sec=30).run("x", temp_dir(self))
        self.assertEqual(r.stop_reason, ERROR)


class DesignDecodeTest(unittest.TestCase):
    def test_vibe_full_data_is_parsed(self):
        text = '✅ 当前文件变量已获取\n\n摘要：\n{"variables": 1}\n\n完整数据：\n{"documentName": "OA", "variables": [{"name": "c"}]}'
        self.assertEqual(_decode("get_variables", text)["documentName"], "OA")

    def test_vibe_error_raises(self):
        with self.assertRaisesRegex(RuntimeError, "没有选中图层"):
            _decode("get_selection_node", [{"type": "text", "text": "❌ 没有选中图层：请先选中"}])

    def test_each_tool_gets_its_own_budget(self):
        out = _clip_each({"get_selection_node": {"html": "<div/>"}, "get_variables": {"v": "x" * 50000}}, 4000)
        self.assertEqual(out["get_selection_node"], {"html": "<div/>"})
        self.assertTrue(out["get_variables"]["truncated"])


if __name__ == "__main__":
    unittest.main()
