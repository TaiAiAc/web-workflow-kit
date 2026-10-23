"""本地网页界面：`agent ui`。

纯本地：Python 标准库 HTTP 服务，只监听 127.0.0.1；页面是随包分发的单个 HTML，不加载任何外部资源。
图在本进程里运行，节点进度和日志写进运行记录，页面轮询读取；运行结束时记录落盘到项目的 .agent/runs/。
页面以“工作空间”组织项目：列表与每个项目选过的 agent 存在 ~/.web-workflow-kit/workspaces.json（见 workspaces.py）。

安全：门禁会执行 rules.yaml 里的命令，所以不能让别的网站借浏览器触发运行——
  - 只接受 Host 为 127.0.0.1 / localhost 的请求（防 DNS rebinding）；
  - 每次启动生成随机令牌，只嵌在本页面里，所有 /api 请求必须带 X-WWK-Token；
  - 禁止被其他页面用 iframe 嵌入。
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from ..pipeline import names as N
from ..pipeline.codegraph import build_codegraph
from ..pipeline.agents import agent_availability, default_fix_choice
from ..pipeline.config import ASSETS_DIR, DEFAULTS, init_project, load_config
from ..pipeline.deps import default_deps, deps_from_state
from ..pipeline.main_graph import build_main_graph
from ..pipeline.review import BACKENDS as REVIEW_BACKENDS
from ..pipeline.review import availability as review_availability
from ..pipeline.reviewgraph import build_reviewgraph
from . import workspaces as W

PAGE = ASSETS_DIR / "ui" / "index.html"
MAX_RUNS = 50
MAX_EVENTS = 5000

# 图名 → 按依赖来源构建图。每次运行现建，日志函数才能绑定到这次运行
BUILDERS: dict[str, Callable[[Any], Any]] = {
    N.PIPELINE_NAME: lambda src: build_main_graph(src, entry="code"),
    N.FIX_LOOP_NAME: lambda src: build_main_graph(src, entry="verify"),
    N.CODEGRAPH_NAME: build_codegraph,
    N.REVIEWGRAPH_NAME: build_reviewgraph,
}

RESULT_KEYS = ("status", "summary", "break_reason", "verify_exit", "attempt", "failures", "history",
               "code_stop_reason", "fix_stop_reason", "changed_files")

# 工具栏「跑门禁」：只跑一次 verify，不审阅不修复。不是 LangGraph 图，不进 /api/graphs
GATE_ONLY = "仅门禁"


def describe_graphs() -> list[dict[str, Any]]:
    """给页面画图、生成表单用：节点、边（含条件边）、输入表单 schema、说明。"""
    out = []
    for name, build in BUILDERS.items():
        g = build(deps_from_state)
        topo = g.get_graph()
        out.append({
            "name": name,
            "description": N.GRAPH_DESCRIPTIONS.get(name, ""),
            "nodes": list(topo.nodes),
            "edges": [{"source": e.source, "target": e.target, "conditional": bool(e.conditional)} for e in topo.edges],
            "input_schema": g.get_input_jsonschema(),
        })
    return out


def describe_agents() -> dict[str, Any]:
    """编程 agent 下拉框：标签、是否在本机找到命令（登录状态要真正调用时才知道）。每次请求现查。"""
    presets = DEFAULTS.get("coding_agents", {})
    items = []
    for key, p in presets.items():
        ok, detail = agent_availability(p)
        items.append({"key": key, "label": p.get("label", key), "available": ok, "detail": detail,
                      "via": {"claude_cli": "Claude Code CLI", "acp": "ACP 协议", "dsh_cli": "命令行"}.get(p.get("backend"), p.get("backend"))})
    # 审阅方式的可用性取决于 API Key（用户级 ~/.web-workflow-kit/.env 或环境变量）和 dsh 是否安装
    cfg = load_config(None)
    return {"default": DEFAULTS.get("code", {}).get("agent", "claude"), "agents": items,
            "fix_default": default_fix_choice(cfg),
            "review_default": DEFAULTS.get("review", {}).get("backend", "auto"),
            "reviewers": review_availability(cfg)}


_PICK_LOCK = threading.Lock()


def pick_folder(initial: str | None = None) -> str | None:
    """弹出系统的“选择文件夹”窗口。浏览器拿不到所选目录的完整路径，所以由本地服务来弹。

    返回所选目录（正斜杠），取消返回 None；本机没有图形界面组件时抛 RuntimeError。
    """
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as e:
        raise RuntimeError("本机 Python 没有 tkinter，无法弹出选择窗口，请手动输入路径") from e
    start = initial if initial and Path(initial).is_dir() else str(Path.home())
    with _PICK_LOCK:  # 同一时间只弹一个窗口
        root = tk.Tk()
        try:
            root.withdraw()
            root.attributes("-topmost", True)  # 否则窗口常被浏览器挡在后面
            path = filedialog.askdirectory(parent=root, initialdir=start, mustexist=True, title="选择前端项目目录")
        finally:
            root.destroy()
    return Path(path).as_posix() if path else None


def pick_file(initial: str | None = None) -> str | None:
    """弹出系统的“选择文件”窗口选设计稿（导出的 .json）。取消返回 None。"""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as e:
        raise RuntimeError("本机 Python 没有 tkinter，无法弹出选择窗口") from e
    start = initial if initial and Path(initial).is_dir() else str(Path.home())
    with _PICK_LOCK:
        root = tk.Tk()
        try:
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askopenfilename(parent=root, initialdir=start, title="选择设计稿",
                                              filetypes=[("设计稿 JSON", "*.json"), ("所有文件", "*")])
        finally:
            root.destroy()
    return Path(path).as_posix() if path else None


POST_ROUTES = {"/api/runs", "/api/pick-folder", "/api/pick-file", "/api/init", "/api/open",
               "/api/workspaces/add", "/api/workspaces/remove", "/api/workspaces/prefs"}


def check_choices(values: dict[str, Any]) -> None:
    """编程 / 修复 agent、审阅方式只接受已知取值（运行输入和工作空间偏好共用）。"""
    for field, what in (("coding_agent", "编程"), ("fix_agent", "修复")):
        agent = values.get(field)
        if agent and agent not in DEFAULTS.get("coding_agents", {}):
            raise ValueError(f"未知的{what} agent：{agent}")
    reviewer = values.get("review_backend")
    if reviewer and reviewer not in REVIEW_BACKENDS:
        raise ValueError(f"未知的审阅方式：{reviewer}")


def inspect_folder(path: str) -> dict[str, Any]:
    """选完目录后给页面一句提示：像不像前端项目、有没有门禁规则。"""
    p = Path(path)
    if not p.is_dir():
        return {"exists": False}
    name = None
    if (p / "package.json").is_file():
        try:
            name = json.loads((p / "package.json").read_text(encoding="utf-8")).get("name")
        except (OSError, ValueError):
            name = None
    return {
        "exists": True,
        "package_json": (p / "package.json").is_file(),
        "name": name,
        "rules_yaml": (p / "rules.yaml").is_file(),
        "agent_config": (p / "agent.config.json").is_file(),
        "git": (p / ".git").exists(),
    }


class Run:
    def __init__(self, graph: str, payload: dict[str, Any]):
        self.id = uuid.uuid4().hex[:12]
        self.graph = graph
        self.input = payload
        self.status = "running"          # running / done / error
        self.events: list[dict[str, Any]] = []
        self.result: dict[str, Any] = {}
        self.error = ""
        self.started = time.time()
        self.finished: float | None = None
        self.lock = threading.Lock()

    @property
    def project_root(self) -> str:
        return str(self.input.get("project_root", ""))

    def emit(self, event: dict[str, Any]) -> None:
        with self.lock:
            if len(self.events) < MAX_EVENTS:
                self.events.append({"t": round(time.time() - self.started, 2), **event})

    def log(self, line: str) -> None:
        self.emit({"type": "log", "text": str(line)})

    def brief(self) -> dict[str, Any]:
        return {
            "id": self.id, "graph": self.graph, "status": self.status,
            "project_root": self.project_root, "requirement": self.input.get("requirement", ""),
            "coding_agent": self.input.get("coding_agent", ""),
            "review_backend": self.input.get("review_backend", ""),
            "fix_agent": self.input.get("fix_agent", ""),
            "summary": self.result.get("summary", self.error), "result_status": self.result.get("status"),
            "started": self.started, "finished": self.finished,
        }

    def record(self) -> dict[str, Any]:
        with self.lock:
            events = list(self.events)
        return {**self.brief(), "input": self.input, "result": self.result, "error": self.error, "events": events}

    def execute(self) -> None:
        def source(state: dict[str, Any]):
            root = state.get("project_root") or self.project_root
            return default_deps(load_config(root), log=self.log,
                                coding_agent=state.get("coding_agent") or self.input.get("coding_agent"),
                                review_backend=state.get("review_backend") or self.input.get("review_backend"),
                                fix_agent=state.get("fix_agent") or self.input.get("fix_agent"))

        try:
            if self.graph == GATE_ONLY:
                self.result = self._gate_only(source({"project_root": self.project_root}))
                self.status = "done"
                return
            graph = BUILDERS[self.graph](source).with_config({"recursion_limit": 200})
            final: dict[str, Any] = {}
            # subgraphs=True：编码、审阅修复里的子节点（Spec / 写代码 / 审阅 / 修复）也上报，页面按阶段展示
            for ns, mode, chunk in graph.stream(self.input, stream_mode=["tasks", "values"], subgraphs=True):
                parent = ns[0].split(":", 1)[0] if ns else None
                if mode == "values":
                    if not ns:
                        final = chunk
                elif "input" in chunk:   # 任务开始
                    self.emit({"type": "node_start", "node": chunk["name"], "parent": parent})
                else:                    # 任务结束
                    err = chunk.get("error")
                    self.emit({"type": "node_end", "node": chunk["name"], "parent": parent,
                               "error": str(err) if err else None})
            self.result = json.loads(json.dumps({k: final.get(k) for k in RESULT_KEYS if k in final},
                                                ensure_ascii=False, default=str))
            self.status = "done"
        except Exception as e:  # 图本身抛错（如缺 project_root）：记下来，页面上显示
            self.error = f"{type(e).__name__}: {e}"
            self.log(traceback.format_exc(limit=3))
            self.status = "error"
        finally:
            self.finished = time.time()
            self.emit({"type": "end", "status": self.status})
            W.save_run(self.project_root, self.record())

    def _gate_only(self, deps: Any) -> dict[str, Any]:
        self.emit({"type": "node_start", "node": N.VERIFY, "parent": None})
        r = deps.gate()
        status = "passed" if r.passed else ("config_error" if r.exit_code == 2 else "failed")
        codes = "、".join(sorted({f.get("code", "") for f in r.failures}))
        summary = {"passed": "门禁通过。", "failed": f"门禁未通过：{codes}。",
                   "config_error": f"门禁规则或运行环境有误：{codes}。"}[status]
        self.log(f"[门禁] {summary}")
        self.emit({"type": "node_end", "node": N.VERIFY, "parent": None, "error": None})
        return {"status": status, "verify_exit": r.exit_code, "failures": list(r.failures), "summary": summary}


class RunStore:
    def __init__(self) -> None:
        self.runs: dict[str, Run] = {}
        self.lock = threading.Lock()

    def start(self, graph: str, payload: dict[str, Any]) -> Run:
        root = str(payload.get("project_root", "")).strip()
        if not root:
            raise ValueError("请填写项目路径")
        if not Path(root).is_dir():
            raise ValueError(f"项目路径不存在或不是目录：{root}")
        with self.lock:
            busy = [r for r in self.runs.values()
                    if r.status == "running" and Path(r.project_root).resolve() == Path(root).resolve()]
            if busy:
                raise ValueError("该项目已有一次运行在进行中，请等它结束（两次运行同时改同一个仓库会互相覆盖）")
            run = Run(graph, {**payload, "project_root": root})
            self.runs[run.id] = run
            for old in list(self.runs)[:-MAX_RUNS]:
                if self.runs[old].status != "running":
                    del self.runs[old]
        threading.Thread(target=run.execute, name=f"run-{run.id}", daemon=True).start()
        return run

    def for_project(self, project: str) -> list[dict[str, Any]]:
        """某个项目的运行记录：内存里的（含进行中）+ 项目里落盘的，按开始时间倒序。"""
        key = W.normalize(project)
        with self.lock:
            live = [r.brief() for r in self.runs.values() if W.normalize(r.project_root) == key]
        ids = {r["id"] for r in live}
        merged = live + [r for r in W.saved_runs(key) if r.get("id") not in ids]
        return sorted(merged, key=lambda r: r.get("started") or 0, reverse=True)


def describe_workspace(ws: dict[str, Any], store: RunStore) -> dict[str, Any]:
    runs = store.for_project(ws["path"])
    return {**ws, "inspect": inspect_folder(ws["path"]), "branch": W.git_branch(ws["path"]),
            "last_run": runs[0] if runs else None}


def open_folder(path: str) -> None:
    """用系统的文件管理器打开目录。"""
    cmd = ["open", path] if sys.platform == "darwin" else ["explorer", path] if os.name == "nt" else ["xdg-open", path]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def make_handler(store: RunStore, token: str, port: int, graphs: list[dict[str, Any]],
                 picker: Callable[[str | None], str | None] = pick_folder,
                 file_picker: Callable[[str | None], str | None] | None = None,
                 opener: Callable[[str], None] = open_folder):
    file_picker = file_picker or pick_file
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    page = PAGE.read_text(encoding="utf-8").replace("__WWK_TOKEN__", token)

    class Handler(BaseHTTPRequestHandler):
        server_version = "web-workflow-kit"

        def log_message(self, fmt: str, *args: Any) -> None:  # 静默访问日志，终端只留有用信息
            pass

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                             "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, data: Any) -> None:
            self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _guard(self, api: bool) -> bool:
            if self.headers.get("Host") not in allowed_hosts:
                self._json(HTTPStatus.FORBIDDEN, {"error": "只接受本机访问"})
                return False
            if api and not secrets.compare_digest(self.headers.get("X-WWK-Token", ""), token):
                self._json(HTTPStatus.FORBIDDEN, {"error": "令牌无效，请刷新页面"})
                return False
            return True

        def do_GET(self) -> None:
            url = urlparse(self.path)
            if url.path in ("/", "/index.html"):
                if self._guard(api=False):
                    self._send(HTTPStatus.OK, page.encode("utf-8"), "text/html; charset=utf-8")
                return
            if not url.path.startswith("/api/"):
                return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            if not self._guard(api=True):
                return
            parts = url.path.strip("/").split("/")
            if parts == ["api", "graphs"]:
                return self._json(HTTPStatus.OK, graphs)
            if parts == ["api", "agents"]:
                return self._json(HTTPStatus.OK, describe_agents())
            if parts == ["api", "inspect"]:
                return self._json(HTTPStatus.OK, inspect_folder(parse_qs(url.query).get("path", [""])[0]))
            query = parse_qs(url.query)
            project = query.get("project", [""])[0]
            if parts == ["api", "workspaces"]:
                return self._json(HTTPStatus.OK, [describe_workspace(w, store) for w in W.load()])
            if parts == ["api", "runs"]:
                if project:
                    return self._json(HTTPStatus.OK, store.for_project(project))
                runs = sorted(store.runs.values(), key=lambda r: r.started, reverse=True)
                return self._json(HTTPStatus.OK, [r.brief() for r in runs])
            if len(parts) == 3 and parts[:2] == ["api", "runs"]:
                run = store.runs.get(parts[2])
                rec = run.record() if run else (W.load_run(project, parts[2]) if project else None)
                if not rec:
                    return self._json(HTTPStatus.NOT_FOUND, {"error": "运行记录不存在"})
                after = int(query.get("after", ["0"])[0] or 0)
                events = rec.get("events", [])[after:]
                return self._json(HTTPStatus.OK, {**rec, "events": events, "next": after + len(events)})
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:
            url = urlparse(self.path)
            if not self._guard(api=True):
                return
            if url.path not in POST_ROUTES:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "需要 application/json"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0) or 0)) or b"{}")
            except json.JSONDecodeError:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "请求体不是合法的 JSON"})
            if url.path.startswith("/api/workspaces/") or url.path == "/api/open":
                return self._workspace_action(url.path, body)
            if url.path == "/api/init":  # 等同 agent --init：复制默认配置，已存在的不覆盖
                try:
                    raw = str(body.get("path") or "").strip()
                    if not raw:
                        raise ValueError("请填写项目路径")
                    root = Path(raw)
                    if not root.is_dir():
                        raise ValueError(f"项目路径不存在或不是目录：{raw}")
                    files = init_project(root)
                except (ValueError, OSError) as e:
                    return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
                return self._json(HTTPStatus.OK, {"created": [p.name for p, c in files if c],
                                                  "skipped": [p.name for p, c in files if not c],
                                                  "inspect": inspect_folder(str(root))})
            if url.path in ("/api/pick-folder", "/api/pick-file"):
                try:
                    path = (picker if url.path == "/api/pick-folder" else file_picker)(body.get("initial"))
                except RuntimeError as e:
                    return self._json(HTTPStatus.NOT_IMPLEMENTED, {"error": str(e)})
                return self._json(HTTPStatus.OK, {"path": path, "inspect": inspect_folder(path) if path else None})
            try:
                graph = body.get("graph")
                if graph not in BUILDERS and graph != GATE_ONLY:
                    raise ValueError(f"未知的图：{graph}")
                payload = {k: v for k, v in (body.get("input") or {}).items() if v not in (None, "")}
                check_choices(payload)
                run = store.start(graph, payload)
            except ValueError as e:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
            self._json(HTTPStatus.CREATED, {"id": run.id})

        def _workspace_action(self, path: str, body: dict[str, Any]) -> None:
            try:
                target = str(body.get("path") or "").strip()
                if path == "/api/workspaces/add":
                    return self._json(HTTPStatus.OK, describe_workspace(W.add(target), store))
                ws = W.find(target) if target else None
                if not ws:  # 删除 / 设置 / 打开目录都只针对已添加的工作空间
                    raise ValueError(f"不是已添加的工作空间：{target}")
                if path == "/api/workspaces/remove":
                    W.remove(target)
                    return self._json(HTTPStatus.OK, {"removed": ws["path"]})
                if path == "/api/workspaces/prefs":
                    prefs = body.get("prefs") or {}
                    check_choices(prefs)
                    return self._json(HTTPStatus.OK, describe_workspace(W.set_prefs(target, prefs), store))
                opener(ws["path"])
                return self._json(HTTPStatus.OK, {"opened": ws["path"]})
            except (ValueError, OSError) as e:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})

    return Handler


def create_server(port: int = 8765, picker: Callable[[str | None], str | None] = pick_folder,
                  file_picker: Callable[[str | None], str | None] | None = None,
                  opener: Callable[[str], None] = open_folder) -> tuple[ThreadingHTTPServer, str]:
    token = secrets.token_urlsafe(24)
    graphs = describe_graphs()
    store = RunStore()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(store, token, port, graphs, picker, file_picker, opener))
    server.daemon_threads = True
    # port=0 时由系统分配端口，Host 校验要用实际端口
    if port == 0:
        real = server.server_address[1]
        server.RequestHandlerClass = make_handler(store, token, real, graphs, picker, file_picker, opener)
    server.store = store  # type: ignore[attr-defined]
    return server, token


def serve(port: int = 8765, open_browser: bool = True) -> int:
    try:
        server, _ = create_server(port)
    except OSError as e:
        print(f"端口 {port} 无法使用（{e}）。换一个：agent ui --port 8766")
        return 1
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"前端交付流水线 · 本地控制台已启动：{url}")
    print("只监听本机；按 Ctrl+C 停止。")
    if open_browser:
        import webbrowser
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0
