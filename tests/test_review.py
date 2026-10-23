"""验收审阅后端：auto / api / dsh / skip，以及 dsh 审阅的只读校验。"""
from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

from tests.test_pipeline import temp_dir
from web_workflow_kit.pipeline import llm
from web_workflow_kit.pipeline.config import load_config
from web_workflow_kit.pipeline.deps import default_deps, deps_from_state
from web_workflow_kit.pipeline.review import extract_plan, resolve_backend

PAYLOAD = {"failures": [{"code": "TYPECHECK_FAIL", "check": "typecheck", "message": "x", "locations": ["src/a.ts:1"]}],
           "diff_hunks": []}

# 假 dsh：先打几行日志（含无关的花括号），再输出计划；FAKE_DSH_WRITE 指定时还会偷偷改文件
FAKE_DSH = r'''
import json, os, sys
print("dsh 0.9 booting {profile: headless}")
print("reading task…")
if os.environ.get("FAKE_DSH_WRITE"):
    open(os.environ["FAKE_DSH_WRITE"], "w").write("oops")
print(json.dumps({"verdict": "fixable", "summary": "类型不匹配", "pass": True,
                  "fixes": [{"code": "TYPECHECK_FAIL", "file": "src/a.ts", "line": 1, "instruction": "改类型", "confidence": 0.8}]},
                 ensure_ascii=False))
print("done.")
'''


class ResolveBackendTest(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config(temp_dir(self))
        self.cfg.env.clear()

    def test_auto_prefers_api_key_then_dsh_then_skip(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "k"}):
            self.assertEqual(resolve_backend(self.cfg)[0], "api")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DEEPSEEK_API_KEY", None)
            with mock.patch("web_workflow_kit.pipeline.review.shutil.which", return_value="C:/dsh.cmd"):
                self.assertEqual(resolve_backend(self.cfg), ("dsh", "未配置 API Key，本机有 dsh"))
            with mock.patch("web_workflow_kit.pipeline.review.shutil.which", return_value=None):
                self.assertEqual(resolve_backend(self.cfg)[0], "skip")

    def test_explicit_choice_and_unknown(self):
        self.assertEqual(resolve_backend(self.cfg, "skip"), ("skip", "手动指定"))
        with self.assertRaisesRegex(ValueError, "未知的审阅方式"):
            resolve_backend(self.cfg, "gpt")

    def test_extract_plan_ignores_log_noise(self):
        text = 'boot {profile: x}\n{"note": 1}\n{"verdict": "fixable", "fixes": []}\ntrailing'
        self.assertEqual(extract_plan(text)["verdict"], "fixable")
        with self.assertRaises(llm.LLMError):
            extract_plan("no json here {")


class ReviewerRunTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir(self)
        script = self.root.parent / f"fake_dsh_{self.root.name}.py"
        script.write_text(FAKE_DSH, encoding="utf-8")
        self.addCleanup(script.unlink)
        (self.root / "agent.config.json").write_text(json.dumps(
            {"review": {"dsh_command": [sys.executable, str(script), "{prompt}"]}}), encoding="utf-8")
        (self.root / "src").mkdir()
        (self.root / "src" / "a.ts").write_text("let a: number = 'x'", encoding="utf-8")
        self.cfg = load_config(self.root)

    def reviewer(self, choice):
        return default_deps(self.cfg, review_backend=choice, log=lambda _l: None).reviewer

    def test_skip(self):
        plan = self.reviewer("skip")(PAYLOAD)
        self.assertEqual((plan["verdict"], plan["reviewer"]), ("unavailable", "skip"))

    def test_dsh_review_parses_plan_and_strips_pass(self):
        plan = self.reviewer("dsh")(PAYLOAD)
        self.assertEqual((plan["verdict"], plan["reviewer"]), ("fixable", "dsh"))
        self.assertNotIn("pass", plan)                      # 顾问无放行权
        self.assertEqual(plan["fixes"][0]["file"], "src/a.ts")
        task = (self.root / ".agent" / "review-task.md").read_text(encoding="utf-8")
        self.assertIn("TYPECHECK_FAIL", task)
        self.assertIn("只读", task)

    def test_dsh_review_that_modifies_files_is_a_violation(self):
        with mock.patch.dict(os.environ, {"FAKE_DSH_WRITE": str(self.root / "src" / "a.ts")}):
            plan = self.reviewer("dsh")(PAYLOAD)
        self.assertEqual(plan["verdict"], "needs_human")     # → 熔断，交给人
        self.assertEqual(plan["violation"], ["src/a.ts"])
        self.assertIn("违规改动了文件：src/a.ts", plan["summary"])

    def test_api_review_uses_key_and_json_mode(self):
        calls = {}

        def fake_chat(base_url, key, model, system, user, json_mode=False, timeout=0):
            calls.update(key=key, json_mode=json_mode)
            return json.dumps({"verdict": "fixable", "pass": True, "fixes": []})

        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-test"}), \
                mock.patch("web_workflow_kit.pipeline.review.llm.chat", side_effect=fake_chat):
            plan = self.reviewer("api")(PAYLOAD)
        self.assertEqual((plan["verdict"], plan["reviewer"]), ("fixable", "api"))
        self.assertNotIn("pass", plan)
        self.assertEqual(calls, {"key": "sk-test", "json_mode": True})

    def test_server_mode_reads_choice_from_input(self):
        deps = deps_from_state({"project_root": str(self.root), "review_backend": "skip"})
        self.assertEqual(deps.reviewer(PAYLOAD)["reviewer"], "skip")


if __name__ == "__main__":
    unittest.main()
