"""编程 agent 可选：claude / codex / opencode / dsh。"""
from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

from tests.test_integrations import STUB, _has_acp
from tests.test_pipeline import temp_dir
from web_workflow_kit.pipeline.acp_agent import ACPAgent
from web_workflow_kit.pipeline.agents import (
    END_TURN, ClaudeCodeCLI, CommandAgent, agent_availability, build_coding_agent, coding_agent_choices,
)
from web_workflow_kit.pipeline.config import load_config
from web_workflow_kit.pipeline.deps import default_deps, deps_from_state


class CodingAgentChoiceTest(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config(temp_dir(self))

    def test_four_choices_with_labels(self):
        choices = coding_agent_choices(self.cfg)
        self.assertEqual(list(choices), ["claude", "codex", "opencode", "dsh"])
        self.assertEqual([c["label"] for c in choices.values()], ["Claude Code", "Codex", "OpenCode", "DeepSeek Harness"])

    def test_each_choice_builds_its_driver(self):
        self.assertIsInstance(build_coding_agent(self.cfg, "claude"), ClaudeCodeCLI)
        codex = build_coding_agent(self.cfg, "codex")
        self.assertIsInstance(codex, ACPAgent)
        self.assertEqual((codex.agent, codex.command), ("codex", None))   # 用 langgraph-acp 自带的 codex-acp 适配器
        opencode = build_coding_agent(self.cfg, "opencode")
        self.assertEqual((opencode.agent, opencode.command), ("opencode", ["opencode", "acp"]))
        dsh = build_coding_agent(self.cfg, "dsh")
        self.assertIsInstance(dsh, CommandAgent)
        self.assertEqual(dsh.task_file.name, "code-task.md")              # 写代码与修复各用各的任务文件

    def test_default_and_timeout_come_from_code_section(self):
        self.assertIsInstance(build_coding_agent(self.cfg), ClaudeCodeCLI)  # code.agent 默认 claude
        self.cfg.raw["code"] = {"agent": "dsh", "timeout_sec": 42}
        agent = build_coding_agent(self.cfg)
        self.assertEqual((type(agent), agent.timeout), (CommandAgent, 42))

    def test_unknown_choice_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "未知的编程 agent"):
            build_coding_agent(self.cfg, "cursor")

    def test_server_mode_reads_choice_from_input(self):
        deps = deps_from_state({"project_root": str(self.cfg.project_root), "coding_agent": "opencode"})
        self.assertEqual(deps.coder.agent, "opencode")

    def test_availability_checks_the_command(self):
        self.assertEqual(agent_availability({"requires": "definitely-not-installed-xyz"}),
                         (False, "未找到 definitely-not-installed-xyz 命令"))
        self.assertTrue(agent_availability({"requires": os.path.basename(sys.executable)})[0])

    def test_command_agent_instruction_is_generic(self):
        root = temp_dir(self)
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"] = cmd
            return mock.Mock(returncode=0, stdout="", stderr="")

        agent = CommandAgent([sys.executable, "{prompt}"], root / ".agent" / "code-task.md")
        with mock.patch("web_workflow_kit.pipeline.agents.subprocess.run", side_effect=fake_run):
            self.assertEqual(agent.run("写个登录页", root).stop_reason, END_TURN)
        self.assertIn("carry out the task", seen["cmd"][-1])                # 不再写死“apply the fixes”
        self.assertEqual((root / ".agent" / "code-task.md").read_text(encoding="utf-8"), "写个登录页")


@unittest.skipUnless(_has_acp(), "langgraph-acp not installed")
class ChosenAgentIsReallyUsedTest(unittest.TestCase):
    def test_project_config_can_point_opencode_at_another_acp_cli(self):
        """项目 agent.config.json 覆盖 opencode 的命令（这里指向 ACP 桩），选 opencode 时真的走它写文件。"""
        root = temp_dir(self)
        (root / "agent.config.json").write_text(json.dumps(
            {"coding_agents": {"opencode": {"command": [sys.executable, STUB]}}}), encoding="utf-8")
        deps = default_deps(load_config(root), coding_agent="opencode", log=lambda _l: None)
        with mock.patch.dict(os.environ, {"STUB_WRITES": "src/Login.vue", "STUB_STOP": "end_turn"}):
            r = deps.coder.run("写登录页", root)
        self.assertEqual(r.stop_reason, END_TURN)
        self.assertTrue((root / "src" / "Login.vue").is_file())


if __name__ == "__main__":
    unittest.main()
