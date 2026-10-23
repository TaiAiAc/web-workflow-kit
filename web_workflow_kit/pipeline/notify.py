"""熔断邮件：smtplib 标准库；同一错误码组合 24 小时内只发一次。"""
from __future__ import annotations

import hashlib
import json
import smtplib
import ssl
import time
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from .config import Config
from .state import Failure


def dedup_key(project_root: str, failures: list[Failure], reason: str) -> str:
    codes = sorted({f.get("code", "?") for f in failures}) or [reason]
    return hashlib.sha1(f"{project_root}|{','.join(codes)}".encode()).hexdigest()


def _load_cache(path: Path) -> dict[str, float]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def should_send(cache_path: Path, key: str, window_hours: float, now: float | None = None) -> bool:
    now = now or time.time()
    last = _load_cache(cache_path).get(key)
    return last is None or now - last >= window_hours * 3600


def mark_sent(cache_path: Path, key: str, window_hours: float, now: float | None = None) -> None:
    now = now or time.time()
    cache = {k: v for k, v in _load_cache(cache_path).items() if now - v < window_hours * 3600}
    cache[key] = now
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache), encoding="utf-8")


def format_body(state: dict[str, Any], cfg: Config) -> str:
    lines = [
        f"项目：{cfg.project_root}",
        f"需求：{state.get('requirement', '')}",
        f"熔断原因：{state.get('break_reason', '')}",
        f"门禁轮数：{state.get('attempt', 0)}/{cfg.max_retries}",
        "",
        "失败项：",
    ]
    for f in state.get("failures", []):
        lines.append(f"- [{f.get('code')}] {f.get('message')}")
        lines += [f"    {loc}" for loc in f.get("locations", [])[:5]]
    plan = state.get("plan") or {}
    if plan.get("summary"):
        lines += ["", f"验收顾问结论：{plan.get('verdict')} — {plan['summary']}"]
    lines += ["", f"完整报告：{cfg.state_dir / 'verify-report.json'}", "需要人工介入：修复后在 REPL 里 :verify 重新过门禁。"]
    return "\n".join(lines)


def notify_breaker(state: dict[str, Any], cfg: Config) -> str:
    """返回 sent / deduped / skipped(<原因>)，从不抛异常：通知失败不能掩盖熔断本身。"""
    host, to = cfg.secret("SMTP_HOST"), cfg.secret("NOTIFY_EMAIL")
    if not host or not to:
        return "skipped(SMTP_HOST/NOTIFY_EMAIL not set)"
    window = float(cfg["notify"].get("dedup_hours", 24))
    cache = cfg.state_dir / ".notify_cache"
    key = dedup_key(str(cfg.project_root), state.get("failures", []), state.get("break_reason", ""))
    if not should_send(cache, key, window):
        return "deduped"

    codes = ",".join(sorted({f.get("code", "?") for f in state.get("failures", [])})) or state.get("break_reason", "")
    msg = EmailMessage()
    msg["Subject"] = f"[agent 熔断] {cfg.project_root.name}: {codes}"
    msg["From"] = cfg.secret("SMTP_USER") or to
    msg["To"] = to
    msg.set_content(format_body(state, cfg))

    port = int(cfg.secret("SMTP_PORT") or 465)
    user, password = cfg.secret("SMTP_USER"), cfg.secret("SMTP_PASS")
    try:
        if port == 465:
            server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=30)
        else:
            server = smtplib.SMTP(host, port, timeout=30)
            server.starttls(context=ssl.create_default_context())
        with server:
            if user and password:
                server.login(user, password)
            server.send_message(msg)
    except (OSError, smtplib.SMTPException) as e:
        return f"skipped({type(e).__name__}: {e})"
    mark_sent(cache, key, window)
    return "sent"
