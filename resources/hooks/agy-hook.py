#!/usr/bin/env python3
"""OpenTrade lifecycle hook bridge for Antigravity CLI (agy).

Handles SessionStart, PreToolUse, PostToolUse, and Stop events in agy's
camelCase protojson hook format and forwards them to OpenTrade's local
faucet server (/hook/pretool-approval, /hook/order-result, /hook/status).
Fails closed on PreToolUse if the local OpenTrade server is unreachable.
"""
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import urllib.request

MONEY_MOVERS = frozenset({
    "place_equity_order",
    "cancel_equity_order",
    "place_option_order",
    "cancel_option_order",
    "place_crypto_order",
    "cancel_crypto_order",
    "exercise_option",
    "cancel_option_exercise",
})


def opentrade_home() -> Path:
    env_home = os.environ.get("OPENTRADE_HOME")
    return Path(env_home) if env_home else (Path.home() / ".opentrade")


def resolve_agent_id(home: Path, payload: dict) -> str:
    aid = os.environ.get("OPENTRADE_AGENT_ID", "").strip()
    if aid:
        return aid
    workspaces = payload.get("workspacePaths") or []
    cwd_str = str(workspaces[0]) if workspaces else str(payload.get("cwd") or Path.cwd())
    db_path = home / "app.db"
    if db_path.exists():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
            try:
                for row_id, slug in conn.execute("SELECT id, slug FROM agents").fetchall():
                    if slug and slug in cwd_str:
                        return str(row_id)
            finally:
                conn.close()
        except Exception:
            pass
    return ""


def resolve_host_api(home: Path) -> tuple[int, str]:
    port_str = os.environ.get("OPENTRADE_PORT", "").strip()
    token = os.environ.get("OPENTRADE_TOKEN", "").strip()
    if port_str.isdigit() and token:
        return int(port_str), token
    manifest_path = home / "host.json"
    if manifest_path.exists():
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        return int(data["faucetPort"]), str(data["token"])
    raise RuntimeError("OpenTrade host.json unavailable")


def extract_robinhood_call(payload: dict) -> tuple[str | None, dict]:
    tool_call = payload.get("toolCall")
    if isinstance(tool_call, dict):
        name = str(tool_call.get("name") or "")
        args = tool_call.get("args")
        if not isinstance(args, dict):
            args = {}
        if name == "call_mcp_tool":
            server = str(args.get("ServerName") or args.get("server_name") or "")
            tool_name = str(args.get("ToolName") or args.get("tool_name") or "")
            tool_args = args.get("Arguments") or args.get("arguments") or {}
            if not isinstance(tool_args, dict):
                tool_args = {}
            if server in ("robinhood", "robinhood-trading") and tool_name in MONEY_MOVERS:
                return tool_name, tool_args
            return None, {}
        for prefix in ("mcp__robinhood__", "mcp_robinhood_", "mcp__robinhood-trading__", "mcp_robinhood_trading_"):
            if name.startswith(prefix):
                short = name[len(prefix):]
                if short in MONEY_MOVERS:
                    return short, args
        if name in MONEY_MOVERS:
            return name, args
    raw_name = str(payload.get("tool_name") or "")
    raw_input = payload.get("tool_input")
    if not isinstance(raw_input, dict):
        raw_input = {}
    for prefix in ("mcp__robinhood__", "mcp_robinhood_"):
        if raw_name.startswith(prefix):
            short = raw_name[len(prefix):]
            if short in MONEY_MOVERS:
                return short, raw_input
    if raw_name in MONEY_MOVERS:
        return raw_name, raw_input
    return None, {}


def canonical_key(agent_id: str, tool_name: str, tool_input: object) -> str:
    raw = json.dumps(tool_input if tool_input is not None else {}, sort_keys=True, separators=(",", ":"))
    return f"{agent_id}:{tool_name}:{raw}"


def record_stamp(home: Path, kind: str, key: str, ttl_sec: float = 20.0) -> None:
    stamp_path = home / "runtime" / "agy-gate-stamps.json"
    lock_path = home / "runtime" / "agy-gate-stamps.lock"
    try:
        stamp_path.parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        with lock_path.open("a", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                data = json.loads(stamp_path.read_text(encoding="utf-8")) if stamp_path.exists() else {}
            except Exception:
                data = {}
            bucket = data.get(kind, {})
            bucket = {k: v for k, v in bucket.items() if isinstance(v, (int, float)) and now - v <= ttl_sec}
            bucket[key] = now
            data[kind] = bucket
            stamp_path.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass


def has_stamp(home: Path, kind: str, key: str, ttl_sec: float = 30.0) -> bool:
    stamp_path = home / "runtime" / "agy-gate-stamps.json"
    if not stamp_path.exists():
        return False
    now = time.time()
    try:
        data = json.loads(stamp_path.read_text(encoding="utf-8"))
        ts = data.get(kind, {}).get(key)
        return isinstance(ts, (int, float)) and (now - ts <= ttl_sec)
    except Exception:
        return False


def main() -> None:
    raw_stdin = sys.stdin.read().strip()
    payload: dict = {}
    if raw_stdin:
        try:
            parsed = json.loads(raw_stdin)
            if isinstance(parsed, dict):
                payload = parsed
        except Exception:
            payload = {}

    event = sys.argv[1] if len(sys.argv) > 1 else str(payload.get("hook_event_name") or "")
    home = opentrade_home()
    agent_id = resolve_agent_id(home, payload)

    if event in ("SessionStart", "session-start"):
        conv_id = payload.get("conversationId") or payload.get("session_id")
        transcript_path = payload.get("transcriptPath")
        if conv_id:
            try:
                # Link transcript for opentrade_pipeline / runtime_guard compatibility
                db_path = home / "app.db"
                if db_path.exists():
                    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
                    try:
                        slug_row = conn.execute("SELECT slug FROM agents WHERE id=?", (agent_id,)).fetchone()
                        if slug_row and slug_row[0]:
                            slug_hash = hashlib.sha256((str(home) + ":" + slug_row[0]).encode()).hexdigest()[:10]
                            sessions_dir = home / "cx" / slug_hash / "sessions"
                            sessions_dir.mkdir(parents=True, exist_ok=True)
                            link = sessions_dir / f"{conv_id}.jsonl"
                            target = Path(transcript_path) if transcript_path else None
                            if not target or not target.exists():
                                for root in (Path.home() / ".gemini" / "antigravity" / "brain", Path.home() / ".gemini" / "antigravity-cli" / "brain"):
                                    candidate = root / str(conv_id) / ".system_generated" / "logs" / "transcript.jsonl"
                                    if candidate.exists():
                                        target = candidate
                                        break
                            if target and target.exists() and not link.exists():
                                link.symlink_to(target)
                    finally:
                        conn.close()
            except Exception:
                pass
            try:
                port, token = resolve_host_api(home)
                req_body = json.dumps({
                    "hook_event_name": "SessionStart",
                    "session_id": str(conv_id),
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/hook/status",
                    data=req_body,
                    headers={
                        "Content-Type": "application/json",
                        "X-OpenTrade-Token": token,
                        "X-OpenTrade-Agent": agent_id,
                    },
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    resp.read()
            except Exception:
                pass
        print("{}", flush=True)
        sys.exit(0)

    if event in ("PreToolUse", "pre-tool"):
        short_tool, tool_input = extract_robinhood_call(payload)
        if not short_tool:
            print(json.dumps({"decision": "allow"}), flush=True)
            sys.exit(0)
        try:
            port, token = resolve_host_api(home)
            req_body = json.dumps({
                "tool_name": f"mcp__robinhood__{short_tool}",
                "tool_input": tool_input,
            }).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/hook/pretool-approval",
                data=req_body,
                headers={
                    "Content-Type": "application/json",
                    "X-OpenTrade-Token": token,
                    "X-OpenTrade-Agent": agent_id,
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=360) as resp:
                decision = json.loads(resp.read().decode("utf-8"))
            hook_out = decision.get("hookSpecificOutput", {})
            if hook_out.get("permissionDecision") == "allow":
                record_stamp(home, "pretool_allow", canonical_key(agent_id, short_tool, tool_input), ttl_sec=20.0)
                print(json.dumps({"decision": "allow"}), flush=True)
                sys.exit(0)
            reason = hook_out.get("permissionDecisionReason") or "Order declined in OpenTrade."
            print(json.dumps({"decision": "deny", "reason": str(reason)}), flush=True)
            sys.exit(0)
        except Exception:
            reason = (
                "OpenTrade did not respond; the approval gate fails closed. "
                "Do not retry until the user confirms OpenTrade is running."
            )
            print(json.dumps({"decision": "deny", "reason": reason}), flush=True)
            sys.exit(0)

    if event in ("PostToolUse", "post-tool"):
        short_tool, tool_input = extract_robinhood_call(payload)
        if short_tool:
            key = canonical_key(agent_id, short_tool, tool_input)
            if not has_stamp(home, "posttool_recorded", key, ttl_sec=30.0):
                try:
                    port, token = resolve_host_api(home)
                    tool_resp = payload.get("tool_response")
                    if tool_resp is None and payload.get("error"):
                        tool_resp = {"isError": True, "error": payload.get("error")}
                    req_body = json.dumps({
                        "tool_name": f"mcp__robinhood__{short_tool}",
                        "tool_input": tool_input,
                        "tool_response": tool_resp,
                    }).encode("utf-8")
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/hook/order-result",
                        data=req_body,
                        headers={
                            "Content-Type": "application/json",
                            "X-OpenTrade-Token": token,
                            "X-OpenTrade-Agent": agent_id,
                        },
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        resp.read()
                except Exception:
                    pass
        print("{}", flush=True)
        sys.exit(0)

    if event in ("Stop", "stop", "Notification", "StopFailure"):
        conv_id = payload.get("conversationId") or payload.get("session_id")
        term_reason = str(payload.get("terminationReason") or "")
        err_text = str(payload.get("error") or "")
        if event in ("Stop", "stop") and (term_reason == "ERROR" or err_text):
            hook_event_name = "StopFailure"
        elif event == "stop":
            hook_event_name = "Stop"
        else:
            hook_event_name = event
        try:
            port, token = resolve_host_api(home)
            status_body: dict = {"hook_event_name": hook_event_name}
            if conv_id:
                status_body["session_id"] = str(conv_id)
            if hook_event_name == "StopFailure":
                status_body["error"] = "server_error"
            req_body = json.dumps(status_body).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/hook/status",
                data=req_body,
                headers={
                    "Content-Type": "application/json",
                    "X-OpenTrade-Token": token,
                    "X-OpenTrade-Agent": agent_id,
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
        except Exception:
            pass
        print(json.dumps({"decision": "stop"}), flush=True)
        sys.exit(0)

    print("{}", flush=True)


if __name__ == "__main__":
    main()
