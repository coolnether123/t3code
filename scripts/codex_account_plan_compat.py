#!/usr/bin/python3
"""Bridge new Codex plan names to older T3 decoders until T3 is updated."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading

KNOWN_PLANS = frozenset((
    "free", "go", "plus", "pro", "prolite", "team", "business", "enterprise",
    "self_serve_business_prolite", "self_serve_business_usage_based", "ent26",
    "enterprise_cbp_automation", "enterprise_cbp_usage_based", "edu", "edu_plus",
    "edu_pro", "unknown",
))
ACCOUNT_METHODS = frozenset(("account/read", "account/rateLimits/read"))
ACCOUNT_NOTIFICATIONS = frozenset(("account/updated", "account/rateLimits/updated"))


def normalize_plans(value):
    if isinstance(value, list):
        return [normalize_plans(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "unknown" if key == "planType" and isinstance(item, str)
            and item not in KNOWN_PLANS else normalize_plans(item)
            for key, item in value.items()
        }
    return value


def translate_reply(line, pending):
    try:
        message = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return line
    if not isinstance(message, dict):
        return line
    request_id = message.get("id")
    account_reply = request_id in pending and ("result" in message or "error" in message)
    if account_reply:
        pending.discard(request_id)
    if account_reply or message.get("method") in ACCOUNT_NOTIFICATIONS:
        return (json.dumps(normalize_plans(message), separators=(",", ":")) + "\n").encode()
    return line


def main():
    binary = str(Path.home() / ".local/bin/codex")
    arguments = sys.argv[1:]
    if not arguments or arguments[0] != "app-server" or (
        len(arguments) > 1 and arguments[1] not in ("proxy", "--listen", "--remote-control")
        and not arguments[1].startswith("-")
    ):
        os.execv(binary, [binary, *arguments])
    if arguments[:2] == ["app-server", "proxy"]:
        node = str(Path.home() / ".local/bin/node")
        bridge = str(Path(__file__).resolve().with_name("codex_desktop_plan_compat.mjs"))
        os.execv(node, [node, bridge, *arguments])
    child = subprocess.Popen([binary, *arguments], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    pending = set()
    lock = threading.Lock()
    def relay_input():
        try:
            for line in sys.stdin.buffer:
                try:
                    request = json.loads(line)
                    if isinstance(request, dict) and request.get("method") in ACCOUNT_METHODS:
                        with lock:
                            pending.add(request.get("id"))
                except (ValueError, UnicodeDecodeError):
                    pass
                child.stdin.write(line)
                child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            child.stdin.close()
    def forward_signal(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward_signal)
    threading.Thread(target=relay_input, daemon=True).start()
    try:
        for line in child.stdout:
            with lock:
                reply = translate_reply(line, pending)
            sys.stdout.buffer.write(reply)
            sys.stdout.buffer.flush()
    except BrokenPipeError:
        child.terminate()
    finally:
        child.stdout.close()
    return child.wait()


if __name__ == "__main__":
    sys.exit(main())
