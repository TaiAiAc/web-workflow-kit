"""最小 ACP agent 桩：按 STUB_WRITES 逐个申请写文件权限，获批才真的写，最后以 STUB_STOP 结束本轮。

只用于测试 ACPAgent 的权限策略与 stop_reason 映射，不调用任何模型。
"""
import json
import os
import sys
from pathlib import Path

_next_id = 1000


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)


def ask_permission(session_id, path):
    global _next_id
    _next_id += 1
    send({"jsonrpc": "2.0", "id": _next_id, "method": "session/request_permission", "params": {
        "sessionId": session_id,
        "toolCall": {"toolCallId": f"t{_next_id}", "title": f"Edit {path}", "kind": "edit",
                     "locations": [{"path": path}]},
        "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "reject", "name": "Reject", "kind": "reject_once"}],
    }})
    while True:
        msg = read()
        if msg.get("id") == _next_id:
            return msg.get("result", {}).get("outcome", {}).get("optionId") == "allow"


def main():
    cwd = Path.cwd()
    while True:
        msg = read()
        method, mid = msg.get("method"), msg.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "agentCapabilities": {}}})
        elif method == "session/new":
            cwd = Path(msg["params"]["cwd"])
            send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "stub-1"}})
        elif method == "session/prompt":
            wrote, denied = [], []
            for rel in filter(None, os.environ.get("STUB_WRITES", "").split(";")):
                if ask_permission("stub-1", str(cwd / rel)):
                    target = (cwd / rel).resolve()
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("patched\n", encoding="utf-8")
                    wrote.append(rel)
                else:
                    denied.append(rel)
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "stub-1", "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": f"wrote={wrote} denied={denied}"},
            }}})
            send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": os.environ.get("STUB_STOP", "end_turn")}})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
