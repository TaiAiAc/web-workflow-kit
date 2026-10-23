"""本地网页控制台（agent ui）的测试：起一个真实的本地 HTTP 服务，按页面的方式调用。"""
from __future__ import annotations

import http.client
import json
import os
import re
import tempfile
import threading
import time
import unittest

from tests.test_app import NODE, rules_running
from tests.test_pipeline import temp_dir
from web_workflow_kit.pipeline import names as N
from web_workflow_kit.ui.server import GATE_ONLY, create_server


class LocalConsoleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 工作空间列表写到临时的用户目录，不碰真实的 ~/.web-workflow-kit
        cls.home = tempfile.TemporaryDirectory()
        cls.old_home = os.environ.get("WWK_HOME")
        os.environ["WWK_HOME"] = cls.home.name
        cls.pick = lambda initial: None    # 测试里替换系统文件夹 / 文件窗口
        cls.opened = []
        cls.server, cls.token = create_server(port=0, picker=lambda initial: cls.pick(initial),
                                              file_picker=lambda initial: "/tmp/design.json",
                                              opener=cls.opened.append)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        if cls.old_home is None:
            os.environ.pop("WWK_HOME", None)
        else:
            os.environ["WWK_HOME"] = cls.old_home
        cls.home.cleanup()

    def request(self, method, path, body=None, token=True, host=None, ctype="application/json"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        headers = {"Host": host or f"127.0.0.1:{self.port}", "Content-Type": ctype}
        if token:
            headers["X-WWK-Token"] = self.token
        conn.request(method, path, body=json.dumps(body) if isinstance(body, dict) else body, headers=headers)
        res = conn.getresponse()
        raw = res.read().decode("utf-8")
        conn.close()
        try:
            return res.status, json.loads(raw), res
        except json.JSONDecodeError:
            return res.status, raw, res

    def test_page_is_local_and_carries_token(self):
        status, html, res = self.request("GET", "/", token=False)
        self.assertEqual(status, 200)
        self.assertIn(self.token, html)
        self.assertNotIn("__WWK_TOKEN__", html)
        self.assertIn("前端交付流水线", html)
        # 纯本地：页面不引用任何外部脚本、样式、字体
        self.assertIsNone(re.search(r'(src|href)="https?://', html))
        self.assertEqual(res.getheader("X-Frame-Options"), "DENY")

    def test_api_requires_token_and_local_host(self):
        self.assertEqual(self.request("GET", "/api/graphs", token=False)[0], 403)
        self.assertEqual(self.request("GET", "/api/graphs", host="evil.example:80")[0], 403)
        self.assertEqual(self.request("GET", "/", token=False, host=f"attacker.test:{self.port}")[0], 403)
        # 跨站页面能发的“简单请求”是 text/plain，必须拒绝
        status, _, _ = self.request("POST", "/api/runs", body='{"graph": "x"}', ctype="text/plain")
        self.assertEqual(status, 415)

    def test_graphs_describe_chinese_nodes_and_forms(self):
        status, graphs, _ = self.request("GET", "/api/graphs")
        self.assertEqual(status, 200)
        by_name = {g["name"]: g for g in graphs}
        self.assertEqual(set(by_name), {N.PIPELINE_NAME, N.FIX_LOOP_NAME, N.CODEGRAPH_NAME, N.REVIEWGRAPH_NAME})
        loop = by_name[N.FIX_LOOP_NAME]
        self.assertIn(N.VERIFY, loop["nodes"])
        self.assertTrue(any(e["source"] == N.VERIFY and e["conditional"] for e in loop["edges"]))
        self.assertEqual(loop["input_schema"]["properties"]["project_root"]["title"], "项目路径")
        self.assertTrue(loop["description"])

    def test_agents_dropdown_data(self):
        status, body, _ = self.request("GET", "/api/agents")
        self.assertEqual(status, 200)
        self.assertEqual(body["default"], "claude")
        self.assertEqual([a["key"] for a in body["agents"]], ["claude", "codex", "opencode", "workbuddy", "dsh"])
        self.assertEqual(body["fix_default"], "dsh")
        self.assertTrue(all("available" in a and a["label"] for a in body["agents"]))
        _, graphs, _ = self.request("GET", "/api/graphs")
        form = next(g for g in graphs if g["name"] == N.PIPELINE_NAME)["input_schema"]["properties"]
        self.assertEqual(form["coding_agent"]["title"], "编程 agent")
        self.assertEqual(form["fix_agent"]["title"], "修复 agent")
        status, body, _ = self.request("POST", "/api/runs", {"graph": N.PIPELINE_NAME, "input": {
            "project_root": str(temp_dir(self)), "requirement": "x", "coding_agent": "cursor"}})
        self.assertEqual((status, body["error"]), (400, "未知的编程 agent：cursor"))
        status, body, _ = self.request("POST", "/api/runs", {"graph": N.FIX_LOOP_NAME, "input": {
            "project_root": str(temp_dir(self)), "fix_agent": "cursor"}})
        self.assertEqual((status, body["error"]), (400, "未知的修复 agent：cursor"))
        _, body, _ = self.request("GET", "/api/agents")
        self.assertEqual([r["key"] for r in body["reviewers"]], ["auto", "api", "dsh", "skip"])
        self.assertEqual(body["review_default"], "auto")
        self.assertIn("当前会用", body["reviewers"][0]["label"])
        status, body, _ = self.request("POST", "/api/runs", {"graph": N.FIX_LOOP_NAME, "input": {
            "project_root": str(temp_dir(self)), "review_backend": "gpt"}})
        self.assertEqual((status, body["error"]), (400, "未知的审阅方式：gpt"))

    def test_folder_picker_and_check(self):
        root = temp_dir(self)
        (root / "package.json").write_text('{"name": "my-app"}', encoding="utf-8")
        type(self).pick = lambda initial: root.as_posix()
        status, body, _ = self.request("POST", "/api/pick-folder", {"initial": None})
        self.assertEqual(status, 200)
        self.assertEqual(body["path"], root.as_posix())
        self.assertEqual((body["inspect"]["package_json"], body["inspect"]["name"], body["inspect"]["rules_yaml"]),
                         (True, "my-app", False))
        type(self).pick = lambda initial: None                     # 用户点了取消
        self.assertEqual(self.request("POST", "/api/pick-folder", {})[1], {"path": None, "inspect": None})

        def no_gui(initial):
            raise RuntimeError("本机 Python 没有 tkinter")
        type(self).pick = no_gui
        status, body, _ = self.request("POST", "/api/pick-folder", {})
        self.assertEqual((status, body["error"]), (501, "本机 Python 没有 tkinter"))
        # 弹窗也必须带令牌：别的网站不能借浏览器在你桌面上弹窗
        self.assertEqual(self.request("POST", "/api/pick-folder", {}, token=False)[0], 403)
        _, info, _ = self.request("GET", "/api/inspect?path=" + root.as_posix())
        self.assertTrue(info["exists"] and info["package_json"])
        self.assertFalse(self.request("GET", "/api/inspect?path=Z:/nope")[1]["exists"])

    def test_init_project(self):
        root = temp_dir(self)
        (root / "agent.config.json").write_text("{}", encoding="utf-8")   # 已有的不覆盖
        status, body, _ = self.request("POST", "/api/init", {"path": root.as_posix()})
        self.assertEqual(status, 200)
        self.assertEqual((body["created"], body["skipped"], body["inspect"]["rules_yaml"]),
                         (["rules.yaml"], ["agent.config.json"], True))
        self.assertEqual((root / "agent.config.json").read_text(encoding="utf-8"), "{}")
        self.assertEqual(self.request("POST", "/api/init", {"path": root.as_posix()})[1]["created"], [])
        self.assertEqual(self.request("POST", "/api/init", {"path": ""})[1]["error"], "请填写项目路径")
        self.assertEqual(self.request("POST", "/api/init", {"path": "Z:/nope"})[0], 400)
        self.assertEqual(self.request("POST", "/api/init", {"path": root.as_posix()}, token=False)[0], 403)

    def test_bad_input_gets_chinese_error(self):
        status, body, _ = self.request("POST", "/api/runs", {"graph": N.FIX_LOOP_NAME, "input": {}})
        self.assertEqual((status, body["error"]), (400, "请填写项目路径"))
        status, body, _ = self.request("POST", "/api/runs", {"graph": N.FIX_LOOP_NAME, "input": {"project_root": "Z:/no/such/dir"}})
        self.assertEqual(status, 400)
        self.assertIn("不存在", body["error"])
        self.assertEqual(self.request("POST", "/api/runs", {"graph": "nope", "input": {}})[0], 400)

    @unittest.skipUnless(NODE, "node not on PATH")
    def test_run_streams_progress_and_gate_output(self):
        root = temp_dir(self)
        (root / "rules.yaml").write_text(rules_running("print('types ok')"), encoding="utf-8")
        status, body, _ = self.request("POST", "/api/runs", {"graph": N.FIX_LOOP_NAME, "input": {"project_root": str(root)}})
        self.assertEqual(status, 201)
        run_id, events, deadline = body["id"], [], time.time() + 60
        while time.time() < deadline:
            _, run, _ = self.request("GET", f"/api/runs/{run_id}?after={len(events)}")
            events += run["events"]
            if run["status"] != "running":
                break
            time.sleep(0.2)
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["result"]["status"], "delivered")
        self.assertTrue(run["result"]["summary"].startswith("已交付"))
        started = [e["node"] for e in events if e["type"] == "node_start"]
        self.assertEqual(started, [N.VERIFY, N.DELIVER])
        logs = "\n".join(e["text"] for e in events if e["type"] == "log")
        self.assertIn("✔ typecheck", logs)        # 门禁逐项输出进了日志
        self.assertIn("[门禁] 退出码 0", logs)
        _, runs, _ = self.request("GET", "/api/runs")
        self.assertIn(run_id, [r["id"] for r in runs])

    def test_workspaces_add_prefs_open_remove(self):
        root = temp_dir(self)
        (root / "package.json").write_text('{"name": "shop-admin"}', encoding="utf-8")
        (root / ".git").mkdir()
        (root / ".git" / "HEAD").write_text("ref: refs/heads/feature/login\n", encoding="utf-8")
        status, ws, _ = self.request("POST", "/api/workspaces/add", {"path": str(root)})
        self.assertEqual(status, 200)
        self.assertEqual((ws["name"], ws["branch"], ws["inspect"]["rules_yaml"], ws["last_run"]),
                         ("shop-admin", "feature/login", False, None))
        self.assertEqual(self.request("POST", "/api/workspaces/add", {"path": str(root) + "/"})[1]["path"], ws["path"])  # 同一目录不重复加
        _, items, _ = self.request("GET", "/api/workspaces")
        self.assertEqual([w["path"] for w in items].count(ws["path"]), 1)

        status, ws2, _ = self.request("POST", "/api/workspaces/prefs", {"path": ws["path"], "prefs": {"coding_agent": "codex", "review_backend": "skip"}})
        self.assertEqual((status, ws2["prefs"]), (200, {"coding_agent": "codex", "review_backend": "skip"}))
        _, ws3, _ = self.request("POST", "/api/workspaces/prefs", {"path": ws["path"], "prefs": {"coding_agent": ""}})
        self.assertEqual(ws3["prefs"], {"review_backend": "skip"})                  # 空值 = 回到默认
        status, body, _ = self.request("POST", "/api/workspaces/prefs", {"path": ws["path"], "prefs": {"fix_agent": "cursor"}})
        self.assertEqual((status, body["error"]), (400, "未知的修复 agent：cursor"))

        self.assertEqual(self.request("POST", "/api/open", {"path": ws["path"]})[0], 200)
        self.assertEqual(self.opened[-1], ws["path"])
        status, body, _ = self.request("POST", "/api/open", {"path": "/etc"})      # 只能打开已添加的工作空间
        self.assertEqual(status, 400)
        self.assertIn("不是已添加的工作空间", body["error"])
        self.assertEqual(self.request("POST", "/api/pick-file", {})[1]["path"], "/tmp/design.json")

        self.assertEqual(self.request("POST", "/api/workspaces/remove", {"path": ws["path"]})[0], 200)
        _, items, _ = self.request("GET", "/api/workspaces")
        self.assertNotIn(ws["path"], [w["path"] for w in items])
        self.assertTrue((root / "package.json").exists())                          # 移除不删项目文件
        self.assertEqual(self.request("POST", "/api/workspaces/add", {"path": "Z:/no/such/dir"})[0], 400)

    @unittest.skipUnless(NODE, "node not on PATH")
    def test_gate_only_run_is_saved_with_the_project(self):
        root = temp_dir(self)
        (root / "rules.yaml").write_text(rules_running("print('types ok')"), encoding="utf-8")
        status, body, _ = self.request("POST", "/api/runs", {"graph": GATE_ONLY, "input": {"project_root": str(root)}})
        self.assertEqual(status, 201)
        run_id, deadline = body["id"], time.time() + 60
        while time.time() < deadline:
            _, run, _ = self.request("GET", f"/api/runs/{run_id}")
            if run["status"] != "running":
                break
            time.sleep(0.2)
        self.assertEqual((run["result"]["status"], run["result"]["verify_exit"]), ("passed", 0))
        self.assertEqual([e["node"] for e in run["events"] if e["type"] == "node_start"], [N.VERIFY])
        self.assertTrue((root / ".agent" / "runs" / f"{run_id}.json").is_file())

        # 模拟服务重启：内存里的记录没了，按项目仍能列出、打开
        del self.server.store.runs[run_id]
        project = urllib_quote(str(root))
        _, runs, _ = self.request("GET", f"/api/runs?project={project}")
        self.assertEqual([r["id"] for r in runs], [run_id])
        status, saved, _ = self.request("GET", f"/api/runs/{run_id}?project={project}&after=1")
        self.assertEqual((status, saved["result"]["status"], saved["next"]), (200, "passed", len(run["events"])))
        self.assertEqual(len(saved["events"]), len(run["events"]) - 1)
        self.assertEqual(self.request("GET", f"/api/runs/{run_id}")[0], 404)          # 不带项目找不到落盘记录

    @unittest.skipUnless(NODE, "node not on PATH")
    def test_pipeline_reports_inner_steps(self):
        """编码 / 审阅修复里的子节点（Spec、写代码……）也上报，页面据此画出每一步。"""
        from unittest import mock
        from tests.test_pipeline import FakeAgent
        root = temp_dir(self)
        (root / "rules.yaml").write_text(rules_running("print('types ok')"), encoding="utf-8")
        with mock.patch("web_workflow_kit.pipeline.deps.build_coding_agent", return_value=FakeAgent()), \
                mock.patch("web_workflow_kit.pipeline.deps._spec_fn", return_value=lambda req, design: "spec"):
            _, body, _ = self.request("POST", "/api/runs", {"graph": N.PIPELINE_NAME, "input": {"project_root": str(root), "requirement": "x"}})
            deadline = time.time() + 60
            while time.time() < deadline:
                _, run, _ = self.request("GET", f"/api/runs/{body['id']}")
                if run["status"] != "running":
                    break
                time.sleep(0.2)
        steps = [(e["parent"], e["node"]) for e in run["events"] if e["type"] == "node_start"]
        self.assertEqual(steps, [(None, N.CODE), (N.CODE, N.DESIGN), (N.CODE, N.SPEC), (N.CODE, N.WRITE_CODE),
                                 (None, N.VERIFY), (None, N.DELIVER)])
        self.assertEqual(run["result"]["status"], "delivered")
        self.assertIn("changed_files", run["result"])


def urllib_quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")


if __name__ == "__main__":
    unittest.main()
