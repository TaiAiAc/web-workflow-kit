"""控制台「设置」：各 agent 的登录状态、发起登录，以及 API Key / 代理 / 邮件等环境变量。

- 环境变量写进 .env：全局（~/.web-workflow-kit/.env）或某个工作空间的项目 .env（项目优先）；
  流水线经 Config.child_env() 把它们传给 claude / codex / dsh 等子进程，所以这里填了就对下一次运行生效。
- 密钥只写不读：接口只返回“是否已设置”和末尾几位，页面上永远拿不到完整值。
- 各 CLI 的 OAuth 登录都是交互式的，所以「登录」是在系统终端里打开对应命令（带上这里配的代理）。
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any, Callable

from ..pipeline.config import load_config, user_home

# 页面上按组展示；secret=True 的只写不读
CATALOG: list[dict[str, Any]] = [
    {"key": "HTTPS_PROXY", "group": "proxy", "label": "HTTPS 代理", "placeholder": "http://127.0.0.1:7890",
     "hint": "claude / codex / npx 访问外网用；国内网络连 Anthropic、OpenAI 通常需要"},
    {"key": "HTTP_PROXY", "group": "proxy", "label": "HTTP 代理", "placeholder": "http://127.0.0.1:7890"},
    {"key": "NO_PROXY", "group": "proxy", "label": "不走代理", "placeholder": "127.0.0.1,localhost",
     "hint": "逗号分隔；本机地址务必保留"},
    {"key": "DEEPSEEK_API_KEY", "group": "keys", "label": "DeepSeek API Key", "secret": True, "placeholder": "sk-…",
     "hint": "DeepSeek Harness（dsh）写代码、修复、审阅都要；也用于「DeepSeek API」审阅", "test": "deepseek"},
    {"key": "ANTHROPIC_API_KEY", "group": "keys", "label": "Anthropic API Key", "secret": True, "placeholder": "sk-ant-…",
     "hint": "可选：不想用 claude 账号登录时，Claude Code 改用 API Key 计费"},
    {"key": "OPENAI_API_KEY", "group": "keys", "label": "OpenAI API Key", "secret": True, "placeholder": "sk-…",
     "hint": "可选：Codex 用 API Key 而不是 ChatGPT 账号；Spec 改用 GPT 时也要"},
    {"key": "CODEBUDDY_API_KEY", "group": "keys", "label": "CodeBuddy API Key", "secret": True,
     "hint": "WorkBuddy（CodeBuddy Code）非交互运行用；在 CodeBuddy 控制台创建"},
    {"key": "SMTP_HOST", "group": "mail", "label": "SMTP 服务器", "placeholder": "smtp.qq.com"},
    {"key": "SMTP_PORT", "group": "mail", "label": "端口", "placeholder": "465", "hint": "465 用 SSL，其他端口用 STARTTLS"},
    {"key": "SMTP_USER", "group": "mail", "label": "账号", "placeholder": "you@example.com"},
    {"key": "SMTP_PASS", "group": "mail", "label": "密码 / 授权码", "secret": True},
    {"key": "NOTIFY_EMAIL", "group": "mail", "label": "熔断通知收件人", "placeholder": "team@example.com"},
]
KEYS = {c["key"]: c for c in CATALOG}

_ENV_LOCK = threading.Lock()


def env_file(scope: str, project: str | None = None) -> Path:
    if scope == "user":
        return user_home() / ".env"
    if scope == "project" and project:
        return Path(project) / ".env"
    raise ValueError(f"未知的配置范围：{scope}")


def _mask(value: str) -> str:
    return "已设置" if len(value) < 8 else f"{value[:3]}…{value[-4:]}"


def _read(path: Path) -> dict[str, str]:
    try:
        from dotenv import dotenv_values
    except ImportError:  # pragma: no cover
        return {}
    return {k: v for k, v in dotenv_values(path).items() if v} if path.is_file() else {}


def describe(project: str | None) -> dict[str, Any]:
    """每个变量在全局 / 项目里的值（密钥打码），以及实际生效的来源。"""
    user = _read(env_file("user"))
    proj = _read(env_file("project", project)) if project else {}
    items = []
    for c in CATALOG:
        k, secret = c["key"], c.get("secret", False)
        show = (lambda v: _mask(v)) if secret else (lambda v: v)
        source = "project" if k in proj else "user" if k in user else "system" if os.environ.get(k) else None
        items.append({**c, "user": show(user[k]) if k in user else None,
                      "project": show(proj[k]) if k in proj else None,
                      "system": show(os.environ[k]) if os.environ.get(k) else None, "source": source})
    out: dict[str, Any] = {"items": items, "user_file": env_file("user").as_posix(), "system_proxy": system_proxy()}
    if project:
        out["project_file"] = env_file("project", project).as_posix()
        out["project_env_ignored"] = _git_ignored(Path(project), ".env")
    return out


def save(scope: str, project: str | None, values: dict[str, Any]) -> None:
    """values：{KEY: 新值}；空串 / None = 删除这一项。只接受目录里的变量，其余原样保留。"""
    from dotenv import set_key, unset_key
    unknown = [k for k in values if k not in KEYS]
    if unknown:
        raise ValueError(f"不支持的配置项：{', '.join(unknown)}")
    path = env_file(scope, project)
    with _ENV_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        try:
            path.chmod(0o600)   # 存了密钥：只给自己读写（Windows 上无效但无害）
        except OSError:
            pass
        for k, v in values.items():
            v = (str(v) if v is not None else "").strip()
            if v:
                if "\n" in v:
                    raise ValueError(f"{k} 不能包含换行")
                set_key(str(path), k, v, quote_mode="never")
            elif k in _read(path):
                unset_key(str(path), k, quote_mode="never")


def _git_ignored(root: Path, rel: str) -> bool | None:
    if not (root / ".git").exists() or not shutil.which("git"):
        return None
    r = subprocess.run(["git", "check-ignore", "-q", rel], cwd=root, capture_output=True)
    return r.returncode == 0


def system_proxy() -> str | None:
    """系统设置里的代理（macOS / Windows 读系统配置），页面上一键填入用。"""
    try:
        proxies = urllib.request.getproxies()
    except Exception:  # pragma: no cover
        return None
    p = proxies.get("https") or proxies.get("http")
    if p and "://" not in p:
        p = "http://" + p
    return p


# ---------------- agent 登录状态 ----------------

AGENTS: list[dict[str, Any]] = [
    {"key": "claude", "label": "Claude Code", "cmd": "claude", "install": "npm install -g @anthropic-ai/claude-code",
     "login": ["claude", "auth", "login"], "note": "生成 Spec 固定用它；国内网络需要先在下面配好代理"},
    {"key": "codex", "label": "Codex", "cmd": "codex", "install": "npm install -g @openai/codex @agentclientprotocol/codex-acp@1.13.0",
     "login": ["codex", "login"], "note": "ChatGPT 账号登录，或在 ~/.codex/config.toml 配自定义模型服务，或填 OpenAI API Key"},
    {"key": "opencode", "label": "OpenCode", "cmd": "opencode", "install": "npm install -g opencode-ai",
     "login": ["opencode", "auth", "login"], "note": "登录时选择模型服务商并填它的 Key"},
    {"key": "workbuddy", "label": "WorkBuddy（CodeBuddy）", "cmd": "codebuddy", "install": "npm install -g @tencent-ai/codebuddy-code",
     "login": ["codebuddy"], "note": "首次打开会出现登录菜单；或直接填 CodeBuddy API Key"},
    {"key": "dsh", "label": "DeepSeek Harness", "cmd": "dsh", "install": None,
     "login": None, "note": "没有登录步骤，填 DeepSeek API Key 即可"},
]


def _run(cmd: list[str], env: dict[str, str], timeout: int = 15) -> tuple[int | None, str]:
    exe = shutil.which(cmd[0])
    if not exe:
        return None, ""
    try:
        r = subprocess.run([exe, *cmd[1:]], capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except (subprocess.TimeoutExpired, OSError) as e:
        return -1, str(e)
    return r.returncode, (r.stdout + r.stderr).strip()


def _version(cmd: str, env: dict[str, str]) -> str | None:
    code, out = _run([cmd, "--version"], env, timeout=10)
    return out.splitlines()[0][:60] if code == 0 and out else None


def _status(agent: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    key, cmd = agent["key"], agent["cmd"]
    base = {k: agent[k] for k in ("key", "label", "install", "note")}
    base["can_login"] = bool(agent["login"])
    if not shutil.which(cmd):
        return {**base, "installed": False, "state": "missing", "detail": f"未找到 {cmd} 命令"}
    base.update(installed=True, version=_version(cmd, env))
    if key == "claude":
        code, out = _run(["claude", "auth", "status"], env)
        try:
            data = json.loads(out[out.index("{"):]) if "{" in out else {}
        except ValueError:
            data = {}
        if data.get("loggedIn"):
            who = data.get("email") or data.get("subscriptionType") or data.get("authMethod")
            return {**base, "state": "ok", "detail": f"已登录（{who}）" if who else "已登录"}
        if env.get("ANTHROPIC_API_KEY"):
            return {**base, "state": "ok", "detail": "使用 Anthropic API Key"}
        return {**base, "state": "login", "detail": "未登录"}
    if key == "codex":
        code, out = _run(["codex", "login", "status"], env)
        if code == 0 and "not logged in" not in out.lower():
            return {**base, "state": "ok", "detail": out.splitlines()[0][:80] if out else "已登录"}
        if env.get("OPENAI_API_KEY"):
            return {**base, "state": "ok", "detail": "使用 OpenAI API Key"}
        if _codex_custom_provider():
            return {**base, "state": "ok", "detail": "使用 ~/.codex/config.toml 里的自定义模型服务"}
        return {**base, "state": "login", "detail": "未登录"}
    if key == "opencode":
        code, out = _run(["opencode", "auth", "list"], env)
        m = re.search(r"(\d+)\s+credentials?", out)
        n = int(m.group(1)) if m else 0
        return {**base, "state": "ok" if n else "login", "detail": f"已配置 {n} 个模型服务商" if n else "还没有配置模型服务商"}
    if key == "workbuddy":
        if env.get("CODEBUDDY_API_KEY") or env.get("CODEBUDDY_AUTH_TOKEN"):
            return {**base, "state": "ok", "detail": "使用 CodeBuddy API Key"}
        return {**base, "state": "unknown", "detail": "无法自动检测登录状态：在终端登录过一次即可，或填 API Key"}
    if key == "dsh":
        if env.get("DEEPSEEK_API_KEY"):
            return {**base, "state": "ok", "detail": "已配置 DeepSeek API Key"}
        return {**base, "state": "key", "detail": "缺少 DeepSeek API Key"}
    return {**base, "state": "unknown", "detail": ""}


def _codex_custom_provider() -> bool:
    cfg = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"
    try:
        return any(line.strip().startswith("model_provider") for line in cfg.read_text(encoding="utf-8").splitlines())
    except OSError:
        return False


def agent_statuses(project: str | None) -> list[dict[str, Any]]:
    env = load_config(project).child_env()
    with ThreadPoolExecutor(max_workers=len(AGENTS)) as pool:
        return list(pool.map(lambda a: _status(a, env), AGENTS))


def launch_login(agent_key: str, project: str | None, opener: Callable[[str], None] | None = None) -> str:
    """在系统终端里打开登录命令。返回打开的命令行（展示给用户）。"""
    agent = next((a for a in AGENTS if a["key"] == agent_key), None)
    if not agent:
        raise ValueError(f"未知的 agent：{agent_key}")
    if not agent["login"]:
        raise ValueError(f"{agent['label']} 没有登录步骤，填 API Key 即可")
    if not shutil.which(agent["cmd"]):
        raise ValueError(f"未找到 {agent['cmd']} 命令，请先安装")
    env = load_config(project).child_env()
    prefix = [f"{k}={env[k]}" for k in ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY") if env.get(k)]
    line = " ".join([*(f"export {shlex.quote(p)};" for p in prefix), *map(shlex.quote, agent["login"])]) \
        if os.name != "nt" else " ".join([*(f"set {p}&&" for p in prefix), *agent["login"]])
    (opener or open_terminal)(line)
    return line


def open_terminal(line: str) -> None:
    """在新的系统终端窗口里执行一行命令，窗口留着给用户交互。"""
    if sys.platform == "darwin":
        script = f'tell application "Terminal"\nactivate\ndo script {json.dumps(line)}\nend tell'
        subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif os.name == "nt":
        subprocess.Popen(["cmd", "/c", "start", "", "cmd", "/k", line])
    else:
        term = shutil.which("x-terminal-emulator") or shutil.which("gnome-terminal") or shutil.which("konsole")
        if not term:
            raise RuntimeError("没找到终端程序，请在终端里手动运行：" + line)
        sh = tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False)
        sh.write(f"{line}\nexec $SHELL\n")
        sh.close()
        subprocess.Popen([term, "-e", "sh", sh.name])


# ---------------- 连通性 / 密钥测试 ----------------

NETWORK_TARGETS = [
    ("Anthropic（Claude Code）", "https://api.anthropic.com/"),
    ("OpenAI（Codex）", "https://api.openai.com/"),
    ("DeepSeek", "https://api.deepseek.com/"),
    ("npm 仓库", "https://registry.npmjs.org/"),
]


def _opener(env: dict[str, str]) -> urllib.request.OpenerDirector:
    proxies = {k: env[v] for k, v in (("https", "HTTPS_PROXY"), ("http", "HTTP_PROXY")) if env.get(v)}
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))


def _probe(opener: urllib.request.OpenerDirector, url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    start = time.time()
    try:
        r = opener.open(urllib.request.Request(url, headers={"User-Agent": "web-workflow-kit", **(headers or {})}), timeout=6)
        code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:  # 连接失败、超时、TLS 错误
        return {"ok": False, "status": None, "ms": int((time.time() - start) * 1000), "error": str(getattr(e, "reason", e))[:160]}
    # 能拿到 HTTP 响应就说明网络通了；403 多半是地区限制
    return {"ok": code != 403, "status": code, "ms": int((time.time() - start) * 1000),
            "error": "403：被拒绝，多半需要代理" if code == 403 else None}


NETWORK_DEADLINE = 8   # 秒：整次检测的上限。urllib 的 timeout 只管单次读写，TLS 握手卡住时会远超它


def test_network(project: str | None) -> list[dict[str, Any]]:
    env = load_config(project).child_env()
    opener = _opener(env)
    pool = ThreadPoolExecutor(max_workers=len(NETWORK_TARGETS))
    futures = [pool.submit(_probe, opener, url) for _, url in NETWORK_TARGETS]
    deadline = time.time() + NETWORK_DEADLINE
    results = []
    for (name, url), f in zip(NETWORK_TARGETS, futures):
        try:
            r = f.result(timeout=max(0.0, deadline - time.time()))
        except FutureTimeout:
            r = {"ok": False, "status": None, "ms": NETWORK_DEADLINE * 1000, "error": f"{NETWORK_DEADLINE} 秒内没有响应"}
        results.append({"name": name, "url": url, **r})
    pool.shutdown(wait=False)   # 卡住的请求留在后台自行超时，不拖住页面
    return results


def test_deepseek(project: str | None) -> dict[str, Any]:
    env = load_config(project).child_env()
    key = env.get("DEEPSEEK_API_KEY")
    if not key:
        return {"ok": False, "detail": "还没有填 DeepSeek API Key"}
    r = _probe(_opener(env), "https://api.deepseek.com/models", {"Authorization": f"Bearer {key}"})
    if r["status"] == 200:
        return {"ok": True, "detail": f"Key 有效（{r['ms']} ms）"}
    if r["status"] == 401:
        return {"ok": False, "detail": "Key 无效（401）"}
    return {"ok": False, "detail": r.get("error") or f"请求失败（HTTP {r['status']}）"}
