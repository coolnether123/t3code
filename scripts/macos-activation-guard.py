#!/usr/bin/env python3
"""Task-scoped, read-only pre-stop guard. Never stops, deploys, or installs a job.

Set T3CODE_GUARD_MANIFEST to a fresh owner-only JSON file outside Git. Required
keys: task, hostname, user, home, expires_at (Unix seconds), environment_id,
endpoint (http://127.0.0.1:PORT), database, environment_file, processes (list of
{pid, uid, started, command_sha256}), listener_pid, source_root, commit,
candidate_identity_file, candidate_identity_sha256, allocation_bytes,
baseline_file, node, ws_require_from, native_socket. Paths must be absolute.

--capture admits two unchanged idle observations, then creates baseline_file
exclusively. --gate-only requires that baseline and makes no writes. A bounded
--wait-seconds N retries *only* busy observations, captures once and exits. It
never runs deployment. Existing deployment hooks invoke --gate-only directly.
"""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import pwd
import re
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.request


class Hold(Exception):
    """Invalid identity, changing state, or unavailable proof. Never retry blindly."""


class Busy(Hold):
    """Proven active work. A finite wait may retry this observation."""


def require(condition, reason):
    if not condition:
        raise Hold(reason)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def run(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    require(result.returncode == 0, "required read-only command unavailable")
    return result.stdout.strip()


def private_file(path):
    p = pathlib.Path(path)
    require(p.is_absolute() and not p.is_symlink(), "private path must be absolute and not symlinked")
    info = p.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "private file ownership or permissions differ")
    return p


def load_manifest(path):
    p = private_file(path)
    m = json.loads(p.read_text())
    require(m.get("version") == 1 and bool(m.get("task")), "task-scoped versioned manifest required")
    for key in ("home", "database", "environment_file", "source_root", "candidate_identity_file",
                "baseline_file", "node", "ws_require_from", "native_socket"):
        require(pathlib.Path(m[key]).is_absolute(), "manifest path is not absolute")
    source = pathlib.Path(m["source_root"]).resolve()
    for path in (p, pathlib.Path(m["baseline_file"])):
        require(source != path.resolve() and source not in path.resolve().parents, "private state must be outside source")
        require(".git" not in path.parts, "private state cannot be in Git")
    require(re.fullmatch(r"[0-9a-f]{40}", m["commit"]) is not None, "exact source commit required")
    require(re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", m["endpoint"]) is not None,
            "only exact loopback endpoint permitted")
    require(0 < int(m["endpoint"].rsplit(":", 1)[1]) <= 65535, "invalid endpoint port")
    require(isinstance(m["allocation_bytes"], int) and m["allocation_bytes"] >= 1024 ** 2,
            "projected allocation must include at least 1 MiB")
    require(isinstance(m["processes"], list) and m["processes"], "exact process pins required")
    require(m["listener_pid"] in [p["pid"] for p in m["processes"]], "listener must be pinned")
    m["_manifest_sha256"] = file_digest(p)
    return m


def process_identity(pid):
    require(isinstance(pid, int) and pid > 1, "invalid process pin")
    return {"pid": pid, "uid": int(run(["/bin/ps", "-p", str(pid), "-o", "uid="])),
            "started": run(["/bin/ps", "-p", str(pid), "-o", "lstart="]),
            "command_sha256": hashlib.sha256(run(["/bin/ps", "-ww", "-p", str(pid), "-o", "command="]).encode()).hexdigest()}


def check_pins(m):
    require(platform.system() == "Darwin", "macOS required")
    require(socket.gethostname() == m["hostname"] and pwd.getpwuid(os.getuid()).pw_name == m["user"],
            "host or account changed")
    require(str(pathlib.Path.home()) == m["home"] and os.environ.get("HOME") == m["home"], "home changed")
    require(time.time() < m["expires_at"] <= time.time() + 24 * 3600, "task manifest expired or not finite")
    require(pathlib.Path(m["environment_file"]).read_text().strip() == m["environment_id"], "environment file changed")
    require(run(["git", "-C", m["source_root"], "rev-parse", "HEAD"]) == m["commit"], "source commit changed")
    require(file_digest(m["candidate_identity_file"]) == m["candidate_identity_sha256"], "candidate changed")
    capacity = os.statvfs(m["home"])
    require(capacity.f_bavail * capacity.f_frsize - m["allocation_bytes"] >= 20 * 1024 ** 3,
            "projected free space is below 20 GiB")
    for expected in m["processes"]:
        require(process_identity(expected["pid"]) == expected and expected["uid"] == os.getuid(), "exact process changed or shut down")
    port = m["endpoint"].rsplit(":", 1)[1]
    listeners = run(["/usr/sbin/lsof", "-nP", "-a", "-iTCP:" + port, "-sTCP:LISTEN", "-Fpn"])
    pids, addresses = set(), []
    for line in listeners.splitlines():
        if line.startswith("p"):
            pids.add(int(line[1:]))
        elif line.startswith("n"):
            addresses.append(line[1:])
    require(pids == {m["listener_pid"]} and bool(addresses) and all(a == "127.0.0.1:" + port for a in addresses),
            "loopback listener identity changed")
    # No proxies, redirects, pairing, tokens, or authenticated session creation.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(m["endpoint"] + "/.well-known/t3/environment", timeout=5) as response:
        require(response.status == 200, "environment endpoint unavailable")
        body = json.loads(response.read(65536))
    require(body.get("environmentId") == m["environment_id"], "endpoint environment changed")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Hold("environment endpoint redirected")


def database_snapshot(path):
    require(pathlib.Path(path).is_file() and not pathlib.Path(path).is_symlink(), "database missing or symlinked")
    db = sqlite3.connect(pathlib.Path(path).as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        rows = lambda sql: db.execute(sql).fetchall()
        count = lambda sql: rows(sql)[0][0]
        invalid = [
            "SELECT count(*) FROM provider_session_runtime WHERE status IS NULL OR status NOT IN ('starting','running','stopped','error')",
            "SELECT count(*) FROM projection_thread_sessions WHERE status IS NULL OR status NOT IN ('idle','starting','running','ready','interrupted','stopped','error')",
            "SELECT count(*) FROM projection_pending_approvals WHERE status IS NULL OR status NOT IN ('pending','resolved','stale')",
            "SELECT count(*) FROM projection_threads WHERE pending_user_input_count IS NULL OR typeof(pending_user_input_count)<>'integer' OR pending_user_input_count<0",
            "SELECT count(*) FROM projection_thread_messages WHERE is_streaming IS NULL OR is_streaming NOT IN (0,1)",
        ]
        require(not any(count(sql) for sql in invalid), "unknown database state")
        activity = [
            "SELECT count(*) FROM provider_session_runtime r LEFT JOIN projection_thread_sessions s ON s.thread_id=r.thread_id WHERE r.status='starting' OR (r.status='running' AND (s.thread_id IS NULL OR s.status<>'ready' OR s.status IS NULL OR s.active_turn_id IS NOT NULL))",
            "SELECT count(*) FROM projection_thread_sessions s LEFT JOIN provider_session_runtime r ON r.thread_id=s.thread_id WHERE (s.status IN ('starting','running') OR s.active_turn_id IS NOT NULL) AND (r.thread_id IS NULL OR r.status NOT IN ('stopped','error'))",
            "SELECT count(*) FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id WHERE m.role='assistant' AND m.is_streaming=1 AND (m.turn_id=t.latest_turn_id OR m.turn_id IS NULL) AND t.deleted_at IS NULL",
        ]
        if any(count(sql) for sql in activity):
            raise Busy("active T3 turn or streaming reply")
        bindings = []
        runtime = rows("SELECT thread_id,provider_name,adapter_key,status,resume_cursor_json FROM provider_session_runtime ORDER BY thread_id")
        for thread, provider, adapter, status, cursor in runtime:
            if status != "running":
                continue
            require(provider == "codex" and adapter in ("codex", "codex_desktop"), "running provider has no native proof recipe")
            native = json.loads(cursor or "null")
            require(isinstance(native, dict) and isinstance(native.get("threadId"), str) and native["threadId"], "native binding mapping unknown")
            bindings.append({"thread_id": thread, "native_id": native["threadId"]})
        approvals = rows("SELECT * FROM projection_pending_approvals WHERE status='pending' ORDER BY request_id")
        inputs = rows("SELECT thread_id,pending_user_input_count FROM projection_threads WHERE pending_user_input_count>0 ORDER BY thread_id")
        events = rows("SELECT * FROM projection_thread_activities WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE pending_user_input_count>0) AND kind IN ('user-input.requested','user-input.resolved') ORDER BY thread_id,activity_id")
        pending = {"approvals_count": len(approvals), "approvals_sha256": digest(approvals),
                   "input_threads_count": len(inputs), "inputs_sha256": digest(inputs),
                   "input_events_count": len(events), "input_events_sha256": digest(events)}
        return {"pending": pending, "bindings": bindings, "runtime_sha256": digest(runtime)}
    finally:
        db.close()


def native_snapshot(m, bindings):
    sock = pathlib.Path(m["native_socket"])
    info = sock.stat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid(), "native socket ownership changed")
    request = {"socket": str(sock), "ws_require_from": m["ws_require_from"], "bindings": bindings}
    helper = pathlib.Path(__file__).with_name("macos-native-idle.mjs")
    result = subprocess.run([m["node"], str(helper)], input=json.dumps(request), capture_output=True, text=True, timeout=120)
    require(result.returncode == 0, "native read-only proof unavailable")
    proof = json.loads(result.stdout)
    if proof.get("busy") is True:
        raise Busy("active native turn")
    require(proof.get("idle") is True and proof.get("bindings_checked") == len(bindings), "native idle proof incomplete")
    return proof


def observe(m):
    check_pins(m)
    before = database_snapshot(m["database"])
    native = native_snapshot(m, before["bindings"])
    after = database_snapshot(m["database"])
    require(before == after, "runtime or pending state changed during native proof")
    check_pins(m)
    return {"manifest_sha256": m["_manifest_sha256"], "environment_id": m["environment_id"],
            "state": after, "native": native}


def admit(m, capture=False):
    baseline = pathlib.Path(m["baseline_file"])
    if capture:
        require(not baseline.exists(), "baseline exists; reconcile rather than recapture")
        first, second = observe(m), observe(m)
        require(first == second, "idle observations changed; no baseline captured")
        parent = baseline.parent.stat()
        require(parent.st_uid == os.getuid() and parent.st_mode & 0o077 == 0, "baseline parent must be private")
        with os.fdopen(os.open(str(baseline), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as stream:
            json.dump(first, stream, sort_keys=True)
        return first
    previous = json.loads(private_file(baseline).read_text())
    current = observe(m)
    require(current == previous, "baseline identity, pending requests, runtime or native state changed")
    return current


def finite_wait(m, seconds, interval=10, clock=time.monotonic, pause=time.sleep):
    require(1 <= seconds <= 3600, "finite wait must be 1..3600 seconds")
    deadline = clock() + seconds
    while True:
        try:
            return admit(m, capture=True)
        except Busy:
            remaining = deadline - clock()
            if remaining <= 0:
                raise Hold("finite idle wait expired; no deployment performed")
            pause(min(interval, remaining))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=os.environ.get("T3CODE_GUARD_MANIFEST"))
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--capture", action="store_true")
    modes.add_argument("--gate-only", action="store_true")
    modes.add_argument("--wait-seconds", type=int)
    args = parser.parse_args()
    try:
        require(bool(args.manifest), "fresh task manifest required")
        m = load_manifest(args.manifest)
        if args.wait_seconds is not None:
            require(1 <= args.wait_seconds <= 3600, "finite wait must be 1..3600 seconds")
            def expired(signum, frame):
                raise Hold("finite idle wait expired; no deployment performed")
            signal.signal(signal.SIGALRM, expired)
            signal.alarm(args.wait_seconds)
        proof = finite_wait(m, args.wait_seconds) if args.wait_seconds is not None else admit(m, args.capture)
        print(json.dumps({"admitted": True, "pending": proof["state"]["pending"]}, sort_keys=True))
        return 0
    except (Hold, OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError) as error:
        # Never include subprocess output, database rows, conversation text or tokens.
        print("activation held: " + (str(error) if isinstance(error, Hold) else type(error).__name__), file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
