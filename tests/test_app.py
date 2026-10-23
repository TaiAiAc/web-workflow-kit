"""LangGraph 应用入口（graph.py / langgraph.json）与命令行的测试。"""
from __future__ import annotations

import io
import json
import shutil
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from tests.test_pipeline import temp_dir
from web_workflow_kit import cli
from web_workflow_kit.pipeline.config import DEFAULT_CONFIG, DEFAULT_RULES, VERIFY_BUNDLE
from web_workflow_kit.pipeline.deps import deps_from_state

REPO = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
def rules_running(code: str) -> str:
    # 整条命令用 JSON 字符串写：它同时是合法的 YAML 双引号标量，Windows 路径里的反斜杠不会出事
    cmd = f'"{sys.executable}" -c "{code}"'
    return f"project_type: web\nprofiles:\n  web:\n    checks: [typecheck]\n    typecheck:\n      run: {json.dumps(cmd)}\n"


PASSING_RULES = rules_running("print('types ok')")


class LangGraphAppTest(unittest.TestCase):
    def test_langgraph_json_points_at_exported_graphs(self):
        from web_workflow_kit import graph

        spec = json.loads((REPO / "langgraph.json").read_text(encoding="utf-8"))
        self.assertEqual(len(spec["graphs"]), 4)
        for graph_id, entry in spec["graphs"].items():
            path, attr = (entry["path"] if isinstance(entry, dict) else entry).split(":")
            self.assertTrue((REPO / path).is_file(), path)
            compiled = getattr(graph, attr)
            self.assertTrue(hasattr(compiled, "invoke"))
            # Studio 的图下拉框显示图 ID、助手名取 compiled.name：两者一致，界面才统一是中文
            self.assertEqual(compiled.name, graph_id)

    def test_studio_input_form_fields(self):
        from web_workflow_kit import graph

        props = graph.pipeline.get_input_jsonschema()["properties"]
        self.assertEqual(set(props), {"project_root", "requirement", "design_ref"})
        self.assertEqual(set(graph.fix_loop.get_input_jsonschema()["properties"]), {"project_root"})

    def test_studio_shows_chinese_names_and_labels(self):
        from web_workflow_kit import graph
        from web_workflow_kit.pipeline import names as N

        self.assertEqual(graph.pipeline.name, N.PIPELINE_NAME)
        self.assertEqual(graph.fix_loop.name, N.FIX_LOOP_NAME)
        nodes = set(graph.pipeline.get_graph().nodes)
        self.assertTrue({N.CODE, N.VERIFY, N.REVIEW, N.DELIVER, N.BREAKER} <= nodes, nodes)
        self.assertTrue({N.DESIGN, N.SPEC, N.WRITE_CODE} <= set(graph.codegraph.get_graph().nodes))
        form = graph.pipeline.get_input_jsonschema()
        self.assertEqual(form["title"], "前端交付流水线 · 输入")
        self.assertEqual(form["properties"]["project_root"]["title"], "项目路径")
        self.assertEqual(form["properties"]["requirement"]["title"], "需求")
        spec = json.loads((REPO / "langgraph.json").read_text(encoding="utf-8"))
        self.assertTrue(all(g["description"] for g in spec["graphs"].values()))

    def test_project_root_is_required(self):
        with self.assertRaisesRegex(ValueError, "project_root is required"):
            deps_from_state({"requirement": "x"})

    @unittest.skipUnless(NODE, "node not on PATH")
    def test_server_mode_fix_loop_with_real_gate(self):
        """按服务端方式调用：依赖由 state.project_root 现建，门禁走随包分发的 verify.mjs。"""
        from web_workflow_kit import graph

        root = temp_dir(self)
        (root / "rules.yaml").write_text(PASSING_RULES, encoding="utf-8")
        out = graph.fix_loop.invoke({"project_root": str(root)})
        self.assertEqual(out["status"], "delivered")       # 机器可读契约保持英文
        self.assertEqual(out["verify_exit"], 0)
        self.assertTrue(out["summary"].startswith("已交付"))  # 给人看的中文结论
        self.assertTrue((root / ".agent" / "delivery.json").is_file())

    @unittest.skipUnless(NODE, "node not on PATH")
    def test_server_mode_breaker_summary_in_chinese(self):
        from web_workflow_kit import graph

        root = temp_dir(self)
        (root / "rules.yaml").write_text("project_type: desktop\nprofiles: {}\n", encoding="utf-8")
        out = graph.fix_loop.invoke({"project_root": str(root)})
        self.assertEqual((out["status"], out["break_reason"]), ("broken", "GATE_CONFIG_ERROR"))
        self.assertIn("门禁规则或运行环境有误", out["summary"])
        self.assertIn("CONFIG_ERROR", out["summary"])


class PackagingTest(unittest.TestCase):
    def test_assets_ship_inside_package(self):
        pkg = REPO / "web_workflow_kit"
        for f in (DEFAULT_CONFIG, DEFAULT_RULES, VERIFY_BUNDLE):
            self.assertTrue(f.is_file(), f)
            self.assertTrue(f.resolve().is_relative_to(pkg), f)
        self.assertTrue((pkg / "assets" / "prompts" / "review-prompt.md").is_file())


class CliTest(unittest.TestCase):
    def run_cli(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(list(argv))
        return code, buf.getvalue()

    def test_init_copies_defaults_without_overwriting(self):
        root = temp_dir(self)
        (root / "rules.yaml").write_text("mine", encoding="utf-8")
        code, out = self.run_cli("--project", str(root), "--init")
        self.assertEqual(code, 0)
        self.assertEqual((root / "rules.yaml").read_text(encoding="utf-8"), "mine")
        self.assertTrue((root / "agent.config.json").is_file())
        self.assertIn("skip", out)

    @unittest.skipUnless(NODE, "node not on PATH")
    def test_verify_exit_code_is_the_gate(self):
        root = temp_dir(self)
        (root / "rules.yaml").write_text(PASSING_RULES, encoding="utf-8")
        self.assertEqual(self.run_cli("--project", str(root), "--verify")[0], 0)
        (root / "rules.yaml").write_text(rules_running("raise SystemExit(2)"), encoding="utf-8")
        code, out = self.run_cli("--project", str(root), "--verify")
        self.assertEqual(code, 1)
        self.assertIn("TYPECHECK_FAIL", out)


if __name__ == "__main__":
    unittest.main()
