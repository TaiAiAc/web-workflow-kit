"""断点恢复：主图每个节点结束后把 state 写进 .agent/checkpoints.sqlite。

进程崩溃或 Ctrl-C 后，`:resume` 从最后一个完成的节点继续；中断时正在跑的那个节点会整体重跑。
依赖 langgraph-checkpoint-sqlite（`pip install .[checkpoint]`），没装就静默退化为不落盘。
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from typing import Iterator

from .config import Config

ENTRIES = ("code", "verify")


def new_thread_id(entry: str) -> str:
    # 入口编码进 thread_id，恢复时才能重建同一张图
    return f"{entry}-{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 10**6:06d}"


def entry_of(thread_id: str) -> str:
    entry = thread_id.split("-", 1)[0]
    if entry not in ENTRIES:
        raise ValueError(f"unknown thread id {thread_id!r}")
    return entry


@contextmanager
def open_checkpointer(cfg: Config) -> Iterator[object | None]:
    if not cfg.raw.get("checkpoint", {}).get("enabled", True):
        yield None
        return
    try:
        from langgraph.checkpoint.sqlite import SqliteSaver
    except ImportError:
        yield None
        return
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(cfg.state_dir / "checkpoints.sqlite", check_same_thread=False)
    try:
        yield SqliteSaver(conn)
    finally:
        conn.close()


def _last_path(cfg: Config):
    return cfg.state_dir / "last_thread.json"


def remember(cfg: Config, thread_id: str) -> None:
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    _last_path(cfg).write_text(json.dumps({"thread_id": thread_id}), encoding="utf-8")


def last_thread(cfg: Config) -> str | None:
    try:
        return json.loads(_last_path(cfg).read_text(encoding="utf-8"))["thread_id"]
    except (OSError, ValueError, KeyError):
        return None
