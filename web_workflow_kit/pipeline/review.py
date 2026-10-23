"""验收审阅（顾问）的后端：DeepSeek API / DeepSeek Harness / 跳过，默认自动选。

顾问只出修复计划、无放行权，且必须只读：
- api：直接调 HTTP 接口，天然改不了文件，并强制 JSON 输出；
- dsh：`dsh headless` 是能改文件的 agent，所以审阅前后各取一次项目文件指纹，
  有任何变化即判为违规（needs_human → 熔断），列出被改的文件交给人处理，不自动回滚；
- skip：不审阅，修复者直接按门禁失败码和出错位置修。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable

from . import llm
from .config import Config, prompt

BACKENDS = {
    "auto": "自动",
    "api": "DeepSeek API",
    "dsh": "DeepSeek Harness",
    "skip": "跳过审阅",
}

# 指纹不看这些目录：依赖、构建产物、流水线自己的产物
SKIP_DIRS = {"node_modules", ".git", ".agent", "dist", "build", "out", "coverage", ".cache",
             ".turbo", ".next", ".nuxt", ".output", ".vite", "unpackage"}


def _api_key(cfg: Config) -> str | None:
    return cfg.secret(cfg["review"].get("api_key_env", "DEEPSEEK_API_KEY"))


def _dsh_command(cfg: Config) -> list[str]:
    return list(cfg["review"].get("dsh_command") or ["dsh", "headless", "{prompt}"])


def resolve_backend(cfg: Config, choice: str | None = None) -> tuple[str, str]:
    """返回（实际后端, 原因）。auto：有 key 用 API，否则装了 dsh 用 dsh，否则跳过。"""
    choice = choice or cfg["review"].get("backend", "auto")
    if choice not in BACKENDS:
        raise ValueError(f"未知的审阅方式：{choice}（可选：{', '.join(BACKENDS)}）")
    if choice != "auto":
        return choice, "手动指定"
    if _api_key(cfg):
        return "api", f"已配置 {cfg['review'].get('api_key_env', 'DEEPSEEK_API_KEY')}"
    if shutil.which(_dsh_command(cfg)[0]):
        return "dsh", "未配置 API Key，本机有 dsh"
    return "skip", "未配置 API Key，本机也没有 dsh"


def availability(cfg: Config) -> list[dict[str, Any]]:
    """给控制台下拉框：每个选项现在能不能用。"""
    key_env = cfg["review"].get("api_key_env", "DEEPSEEK_API_KEY")
    dsh = shutil.which(_dsh_command(cfg)[0])
    auto, why = resolve_backend(cfg, "auto")
    return [
        {"key": "auto", "label": f"自动（当前会用：{BACKENDS[auto]}）", "available": True, "detail": why},
        {"key": "api", "label": BACKENDS["api"], "available": bool(_api_key(cfg)),
         "detail": "只读、强制 JSON 输出" if _api_key(cfg) else f"未配置 {key_env}"},
        {"key": "dsh", "label": BACKENDS["dsh"], "available": bool(dsh),
         "detail": "经 dsh headless；审阅前后校验没有改动文件" if dsh else "未找到 dsh 命令"},
        {"key": "skip", "label": BACKENDS["skip"], "available": True, "detail": "修复者直接按门禁失败码修"},
    ]


def fingerprint(root: Path) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            p = Path(dirpath) / name
            try:
                st = p.stat()
            except OSError:
                continue
            out[p.relative_to(root).as_posix()] = (st.st_size, st.st_mtime_ns)
    return out


def changed_files(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]) -> list[str]:
    return sorted({k for k in before.keys() | after.keys() if before.get(k) != after.get(k)})


def extract_plan(text: str) -> dict[str, Any]:
    """agent 的输出里混着日志：从后往前找最后一个带 verdict 的 JSON 对象。"""
    decoder = json.JSONDecoder()
    found = None
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(text, i)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "verdict" in obj:
            found = obj
    if found is None:
        raise llm.LLMError("审阅输出里没有找到带 verdict 的 JSON")
    return found


def _unavailable(summary: str, backend: str) -> dict[str, Any]:
    # 顾问不可用不阻塞：修复者直接按失败码干活
    return {"verdict": "unavailable", "summary": summary[:300], "fixes": [], "reviewer": backend}


def make_reviewer(cfg: Config, choice: str | None, validate: Callable[[Any], dict[str, Any]]):
    rcfg = cfg["review"]
    system = prompt("review-prompt.md")
    timeout = int(rcfg.get("timeout_sec", 180))

    def run(payload: dict[str, Any]) -> dict[str, Any]:
        backend, why = resolve_backend(cfg, choice)
        if backend == "skip":
            return _unavailable(f"未审阅（{why}）", backend)
        if backend == "api":
            key = _api_key(cfg)
            if not key:
                return _unavailable(f"{rcfg.get('api_key_env')} 未配置", backend)
            try:
                # 无状态：每次只有 system + 本轮 payload，不带历史
                text = llm.chat(rcfg["base_url"], key, rcfg["model"], system,
                                json.dumps(payload, ensure_ascii=False), json_mode=True, timeout=timeout)
                return {**validate(llm.parse_json(text)), "reviewer": backend}
            except (llm.LLMError, json.JSONDecodeError) as e:
                return _unavailable(str(e), backend)
        return _run_dsh(payload, backend)

    def _run_dsh(payload: dict[str, Any], backend: str) -> dict[str, Any]:
        cmd = _dsh_command(cfg)
        exe = shutil.which(cmd[0])
        if not exe:
            return _unavailable(f"未找到 {cmd[0]} 命令", backend)
        root = cfg.project_root
        task = cfg.state_dir / "review-task.md"
        task.parent.mkdir(parents=True, exist_ok=True)
        task.write_text(
            f"{system}\n\n## 本次输入\n\n```json\n{json.dumps(payload, ensure_ascii=False, indent=2)}\n```\n\n"
            "这是**只读**审阅：不要修改、创建或删除任何文件，不要运行会改动文件的命令。"
            "只输出一个符合上面格式的 JSON 对象。\n", encoding="utf-8")
        rel = task.relative_to(root).as_posix() if task.is_relative_to(root) else task.as_posix()
        short = f"Read {rel} and carry out the read-only review it describes. Do not modify any files. Output only the JSON object."
        before = fingerprint(root)
        try:
            r = subprocess.run([exe, *(a.replace("{prompt}", short) for a in cmd[1:])], cwd=root,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                               env=cfg.child_env())
        except subprocess.TimeoutExpired:
            return _unavailable(f"dsh 审阅超时（{timeout}s）", backend)
        touched = changed_files(before, fingerprint(root))
        if touched:
            listed = "、".join(touched[:10]) + (f" 等 {len(touched)} 个" if len(touched) > 10 else "")
            return {"verdict": "needs_human", "summary": f"验收顾问（dsh）违规改动了文件：{listed}。请检查后再继续",
                    "fixes": [], "reviewer": backend, "violation": touched}
        if r.returncode != 0:
            return _unavailable(f"dsh 退出码 {r.returncode}：{(r.stderr or r.stdout)[-300:]}", backend)
        try:
            return {**validate(extract_plan(r.stdout)), "reviewer": backend}
        except (llm.LLMError, json.JSONDecodeError) as e:
            return _unavailable(str(e), backend)

    return run
