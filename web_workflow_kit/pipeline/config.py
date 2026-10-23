"""agent.config.json + .env 加载。路径一律解析成绝对路径。"""
from __future__ import annotations

import copy
import json
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# 默认配置、提示词、门禁脚本都随包分发，pip 安装后在任何目录可用
ASSETS_DIR = Path(__file__).resolve().parents[1] / "assets"
PROMPTS_DIR = ASSETS_DIR / "prompts"
DEFAULT_CONFIG = ASSETS_DIR / "agent.config.json"
DEFAULT_RULES = ASSETS_DIR / "rules.yaml"
VERIFY_BUNDLE = ASSETS_DIR / "verify.mjs"


def user_home() -> Path:
    """用户级配置目录：放全局 .env（SMTP、API Key），不随项目走。"""
    return Path(os.environ.get("WWK_HOME") or Path.home() / ".web-workflow-kit")


DEFAULTS: dict[str, Any] = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))


def init_project(root: str | Path) -> list[tuple[Path, bool]]:
    """把默认 rules.yaml、agent.config.json 复制到项目根目录供修改，已存在的不覆盖。返回 [(目标文件, 是否新建)]。"""
    out = []
    for src in (DEFAULT_RULES, DEFAULT_CONFIG):
        dst = Path(root) / src.name
        created = not dst.exists()
        if created:
            shutil.copyfile(src, dst)
        out.append((dst, created))
    return out


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


@dataclass
class Config:
    raw: dict[str, Any]
    project_root: Path
    state_dir: Path
    env: dict[str, str] = field(default_factory=dict)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    @property
    def max_retries(self) -> int:
        return int(self.raw["max_retries"])

    def secret(self, name: str) -> str | None:
        return self.env.get(name) or os.environ.get(name)


def load_config(project_root: str | Path | None = None, config_path: str | Path | None = None) -> Config:
    """优先级：目标项目里的 agent.config.json > 包内默认值；.env：项目 > 用户级（~/.web-workflow-kit/.env）。"""
    try:
        from dotenv import dotenv_values
    except ImportError:  # pragma: no cover
        dotenv_values = lambda _p: {}  # noqa: E731

    raw = copy.deepcopy(DEFAULTS)
    root = Path(project_root or os.getcwd()).resolve()
    candidates = [Path(config_path)] if config_path else [root / "agent.config.json"]
    for c in candidates:
        if c.is_file() and c.resolve() != DEFAULT_CONFIG:
            raw = _merge(raw, json.loads(c.read_text(encoding="utf-8")))
    if project_root is None and raw.get("project_root"):
        root = (root / raw["project_root"]).resolve()

    env: dict[str, str] = {}
    for p in (user_home() / ".env", root / ".env"):
        if p.is_file():
            env.update({k: v for k, v in dotenv_values(p).items() if v is not None})

    max_retries = int(raw.get("max_retries", 3))
    if max_retries < 1:
        raise ValueError("max_retries must be >= 1")

    state_dir = (root / raw.get("state_dir", ".agent")).resolve()
    return Config(raw=raw, project_root=root, state_dir=state_dir, env=env)


def render(template: str, **values: Any) -> str:
    """{key} 占位替换；不用 str.format，避免 Markdown 里的 JSON 花括号被误解析。"""
    for k, v in values.items():
        template = template.replace("{" + k + "}", v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, indent=2))
    return template


def prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")
