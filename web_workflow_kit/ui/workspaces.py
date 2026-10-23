"""控制台的工作空间：用户加过的项目、每个项目选过的 agent，以及落盘的运行记录。

- 工作空间列表存在用户级目录（~/.web-workflow-kit/workspaces.json），浏览器版和桌面端共用；
- 运行记录在运行结束时写进项目自己的 .agent/runs/<id>.json，服务重启后仍能看到；
- 这里只做文件读写，路径合法性、agent 取值由 server.py 校验。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from ..pipeline.config import load_config, user_home

PREF_KEYS = ("coding_agent", "fix_agent", "review_backend")
MAX_SAVED_RUNS = 50   # 每个项目只留最近这么多条运行记录

_LOCK = threading.Lock()


def _file() -> Path:
    return user_home() / "workspaces.json"


def normalize(path: str) -> str:
    """同一个目录只算一个工作空间：统一成绝对路径、正斜杠。"""
    return Path(path).expanduser().resolve().as_posix()


def load() -> list[dict[str, Any]]:
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [w for w in data if isinstance(w, dict) and w.get("path")] if isinstance(data, list) else []


def _save(items: list[dict[str, Any]]) -> None:
    f = _file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(f)


def find(path: str) -> dict[str, Any] | None:
    key = normalize(path)
    return next((w for w in load() if w["path"] == key), None)


def add(path: str) -> dict[str, Any]:
    p = Path(path).expanduser()
    if not str(path).strip() or not p.is_dir():
        raise ValueError(f"项目路径不存在或不是目录：{path}")
    key = normalize(path)
    with _LOCK:
        items = load()
        found = next((w for w in items if w["path"] == key), None)
        if found:
            return found
        ws = {"path": key, "name": _project_name(Path(key)), "added": time.time(), "prefs": {}}
        _save([ws, *items])  # 新加的排最前
    return ws


def remove(path: str) -> None:
    """只是从列表里移除，不删项目里的任何文件。"""
    key = normalize(path)
    with _LOCK:
        _save([w for w in load() if w["path"] != key])


def set_prefs(path: str, prefs: dict[str, Any]) -> dict[str, Any]:
    key = normalize(path)
    with _LOCK:
        items = load()
        ws = next((w for w in items if w["path"] == key), None)
        if not ws:
            raise ValueError(f"不是已添加的工作空间：{path}")
        current = dict(ws.get("prefs") or {})
        for k in PREF_KEYS:
            if k in prefs:
                if prefs[k]:
                    current[k] = prefs[k]
                else:
                    current.pop(k, None)   # 空值 = 回到默认
        ws["prefs"] = current
        _save(items)
    return ws


def _project_name(p: Path) -> str:
    try:
        name = json.loads((p / "package.json").read_text(encoding="utf-8")).get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    except (OSError, ValueError):
        pass
    return p.name or p.as_posix()


def git_branch(path: str) -> str | None:
    """读 .git/HEAD，不调 git 命令；分离 HEAD 时给短哈希。"""
    head = Path(path) / ".git" / "HEAD"
    try:
        text = head.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text.split("refs/heads/", 1)[1] if text.startswith("ref:") and "refs/heads/" in text else text[:7]


# ---------------- 运行记录落盘 ----------------

def runs_dir(project_root: str) -> Path:
    try:
        state = load_config(project_root).state_dir
    except Exception:  # 配置写坏了也不影响看历史
        state = Path(project_root) / ".agent"
    return state / "runs"


def save_run(project_root: str, record: dict[str, Any]) -> None:
    d = runs_dir(project_root)
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{record['id']}.json").write_text(json.dumps(record, ensure_ascii=False, default=str), encoding="utf-8")
        old = sorted(d.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)[MAX_SAVED_RUNS:]
        for f in old:
            f.unlink(missing_ok=True)
    except OSError:
        pass  # 项目目录不可写时只保留内存里的记录


def saved_runs(project_root: str) -> list[dict[str, Any]]:
    """项目里落盘的运行记录（只取摘要，不带事件）。"""
    out = []
    for f in runs_dir(project_root).glob("*.json"):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({k: v for k, v in rec.items() if k not in ("events", "input", "result", "error")})
    return sorted(out, key=lambda r: r.get("started") or 0, reverse=True)


def load_run(project_root: str, run_id: str) -> dict[str, Any] | None:
    if not run_id.isalnum():
        return None
    try:
        return json.loads((runs_dir(project_root) / f"{run_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
