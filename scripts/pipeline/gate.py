"""调用 verify.ts。放行只看退出码；报告 JSON 只用来把失败项喂给下游。"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .config import VERIFY_DIR, Config
from .state import Failure


@dataclass
class GateResult:
    exit_code: int
    failures: list[Failure] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


def run_gate(cfg: Config, only: list[str] | None = None) -> GateResult:
    node = shutil.which("node")
    if not node:
        return GateResult(2, [{"code": "CONFIG_ERROR", "check": "gate", "message": "node not found on PATH"}])
    if not (VERIFY_DIR / "node_modules").is_dir():
        return GateResult(2, [{"code": "CONFIG_ERROR", "check": "gate", "message": f"run `pnpm install` in {VERIFY_DIR}"}])

    out = cfg.state_dir / "verify-report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    vcfg = cfg["verify"]
    # cwd 设在 verify/ 下，保证 --import tsx 解析到本地依赖；被验项目由 --cwd 指定
    cmd = [node, "--import", "tsx", str(VERIFY_DIR / "verify.ts"), "--cwd", str(cfg.project_root), "--out", str(out)]
    if vcfg.get("rules"):
        cmd += ["--rules", str((cfg.project_root / vcfg["rules"]).resolve())]
    if vcfg.get("type"):
        cmd += ["--type", vcfg["type"]]
    if only:
        cmd += ["--only", ",".join(only)]

    try:
        proc = subprocess.run(cmd, cwd=VERIFY_DIR, timeout=int(vcfg.get("timeout_sec", 3600)))
    except subprocess.TimeoutExpired:
        return GateResult(1, [{"code": "CHECK_TIMEOUT", "check": "gate", "message": "verify.ts exceeded overall timeout"}])

    failures: list[Failure] = []
    if Path(out).is_file():
        failures = json.loads(out.read_text(encoding="utf-8")).get("failures", [])
    if proc.returncode != 0 and not failures:
        failures = [{"code": "CONFIG_ERROR", "check": "gate", "message": f"verify.ts exited {proc.returncode} without a report"}]
    # 退出码就是结论；报告里写了什么都不改变它
    return GateResult(proc.returncode, failures)
