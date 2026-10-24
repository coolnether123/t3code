#!/usr/bin/env python3
"""Start the restored desktop bundle's backend without opening a window."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def backend_environment(environ):
    env = dict(environ)
    for key in list(env):
        if key.startswith(("VITE_", "T3CODE_BOOTSTRAP_")) or key in (
            "T3CODE_DESKTOP_BOOTSTRAP_FD", "T3CODE_PARENT_PID", "NODE_OPTIONS",
        ):
            del env[key]
    env.update(ELECTRON_RUN_AS_NODE="1", T3CODE_TAILSCALE_SERVE="false", T3CODE_NO_BROWSER="true")
    return env


def launch(executable, entry, home, port, environment_id, wait_seconds):
    env = backend_environment(os.environ)
    env.update(T3CODE_HOME=str(home), T3CODE_PORT=str(port), T3CODE_HOST="127.0.0.1")
    argv = [str(executable), str(entry), "serve", "--mode", "web", "--base-dir", str(home),
            "--host", "127.0.0.1", "--port", str(port), "--no-browser"]
    child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
    receipt = {"pid": child.pid, "environmentId": environment_id, "mode": "headless"}
    print(json.dumps({**receipt, "status": "started"}), flush=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + wait_seconds
    while child.poll() is None and time.monotonic() < deadline:
        try:
            listener = subprocess.check_output(
                ["/usr/sbin/lsof", "-nP", "-a", "-p", str(child.pid), "-iTCP:" + str(port),
                 "-sTCP:LISTEN", "-Fpn"], text=True, stderr=subprocess.DEVNULL, timeout=5)
            addresses = [line[1:] for line in listener.splitlines() if line.startswith("n")]
            pids = {line[1:] for line in listener.splitlines() if line.startswith("p")}
            if pids != {str(child.pid)} or not addresses or any(address != "127.0.0.1:" + str(port) for address in addresses):
                raise ValueError("listener differs")
            with opener.open("http://127.0.0.1:" + str(port) + "/.well-known/t3/environment", timeout=5) as response:
                descriptor = json.loads(response.read(65536))
            if not isinstance(descriptor, dict) or descriptor.get("environmentId") != environment_id:
                raise ValueError("environment differs")
            with opener.open("http://127.0.0.1:" + str(port) + "/api/auth/session", timeout=5) as response:
                if response.status != 200 or not response.read(65536):
                    raise ValueError("session endpoint unavailable")
            print(json.dumps({**receipt, "status": "healthy",
                              "commandSha256": hashlib.sha256(json.dumps(argv).encode()).hexdigest()}), flush=True)
            return 0
        except (OSError, ValueError, subprocess.SubprocessError):
            time.sleep(1)
    # An unreaped child cannot have its PID reused. Stop only this captured
    # process after failure, so another server can safely recover the port.
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    print(json.dumps({**receipt, "status": "unhealthy", "exitCode": child.poll()}), flush=True)
    return 1


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect refused")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--entry", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--environment-id", required=True)
    parser.add_argument("--wait-seconds", type=int, default=120)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 15 <= args.wait_seconds <= 600:
        parser.error("invalid port or wait bound")
    if any(not path.is_absolute() for path in (args.executable, args.entry, args.home)):
        parser.error("absolute paths required")
    raise SystemExit(launch(args.executable, args.entry, args.home, args.port,
                           args.environment_id, args.wait_seconds))
