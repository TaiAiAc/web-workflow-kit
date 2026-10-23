"""只取本次改动块，不传整文件。"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from .state import Failure

HUNK = re.compile(r"^@@ .+? @@.*$", re.M)


def _git(root: Path, *args: str) -> str:
    r = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ""


def snapshot(root: Path) -> dict[str, Any]:
    """编码前的基线：`git stash create` 生成工作区快照提交而不改动工作区；干净时退回 HEAD。"""
    rev = _git(root, "stash", "create").strip() or _git(root, "rev-parse", "HEAD").strip()
    untracked = _git(root, "ls-files", "--others", "--exclude-standard").splitlines()
    return {"rev": rev, "untracked": untracked}


def split_hunks(diff: str) -> list[dict[str, str]]:
    hunks: list[dict[str, str]] = []
    for block in re.split(r"^diff --git ", diff, flags=re.M)[1:]:
        m = re.search(r"^\+\+\+ (?:b/)?(.+)$", block, re.M)
        file = m.group(1).strip() if m else block.split()[0].removeprefix("a/")
        if file == "/dev/null":
            file = block.split()[0].removeprefix("a/")
        starts = [h.start() for h in HUNK.finditer(block)]
        for i, s in enumerate(starts):
            body = block[s: starts[i + 1] if i + 1 < len(starts) else len(block)]
            header, _, patch = body.partition("\n")
            hunks.append({"file": file, "header": header, "patch": patch.rstrip("\n")})
    return hunks


def changed_hunks(root: Path, baseline: dict[str, Any] | None, failures: list[Failure],
                  max_chars: int = 12000, context: int = 3) -> list[dict[str, str]]:
    baseline = baseline or {}
    rev = baseline.get("rev") or "HEAD"
    hunks = split_hunks(_git(root, "diff", f"--unified={context}", rev, "--"))

    before = set(baseline.get("untracked", []))
    for rel in _git(root, "ls-files", "--others", "--exclude-standard").splitlines():
        if rel in before:
            continue
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        lines = text.splitlines()
        hunks.append({"file": rel, "header": f"@@ -0,0 +1,{len(lines)} @@ (new file)",
                      "patch": "\n".join("+" + ln for ln in lines)})

    # 失败项点名的文件优先，超出预算的块直接丢弃
    hot = {loc.split(":")[0] for f in failures for loc in f.get("locations", [])}
    hunks.sort(key=lambda h: (not any(h["file"].endswith(x) or x.endswith(h["file"]) for x in hot), h["file"]))
    out, used = [], 0
    for h in hunks:
        size = len(h["patch"]) + len(h["header"]) + len(h["file"])
        if used + size > max_chars:
            if not out:
                out.append({**h, "patch": h["patch"][: max_chars] + "\n…(truncated)"})
            continue
        out.append(h)
        used += size
    return out
