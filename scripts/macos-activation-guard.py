#!/usr/bin/env python3
"""Task-scoped, read-only pre-stop guard. Never stops, deploys, or installs a job.

Set T3CODE_GUARD_MANIFEST to a fresh owner-only JSON file outside Git. Required
keys: task, hostname, user, home, expires_at (Unix seconds), environment_id,
endpoint (http://127.0.0.1:PORT), database, environment_file, processes (list of
{pid, uid, started, command_sha256}), listener_pid, source_root, commit,
candidate_identity_file, candidate_identity_sha256, allocation_bytes,
baseline_file, node, ws_require_from, native_socket. Paths must be absolute.
Optional orphan_requests pins exact {thread_id, request_id} approval identities.
Only archived, interrupted, unbound requests can survive the pre-stop gate;
normal server reconciliation closes them, never this read-only guard.

--capture admits two unchanged idle observations, then creates baseline_file
exclusively. --gate-only never changes that baseline. Native failures save private
stderr diagnostics beside it. A bounded
--wait-seconds N retries *only* busy observations, captures once and exits. It
never runs deployment. Existing deployment hooks invoke --gate-only directly.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import platform
import pwd
import re
import signal
import socket
from contextlib import closing
import sqlite3
import stat
import subprocess
import sys
import tempfile
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


def check_listener_identity(m, listeners, port):
    pids, addresses = set(), []
    for line in listeners.splitlines():
        if line.startswith("p"):
            pids.add(int(line[1:]))
        elif line.startswith("n"):
            addresses.append(line[1:])
    expected = m.get("listener_addresses", ["127.0.0.1:" + port])
    require(isinstance(expected, list) and bool(expected) and len(expected) == len(set(expected))
            and all(a in ("127.0.0.1:" + port, "*:" + port) for a in expected),
            "listener address pins are invalid")
    if "*:" + port in expected:
        proof = m.get("network_config")
        require(isinstance(proof, dict), "wildcard listener requires pinned network settings")
        setting = pathlib.Path(proof["path"])
        require(setting == pathlib.Path(m["environment_file"]).with_name("desktop-settings.json")
                and setting.resolve() == setting, "network settings path is not the actual userdata setting")
        require(setting.is_absolute() and setting.is_file() and not setting.is_symlink()
                and setting.stat().st_uid == os.getuid(), "network settings ownership changed")
        require(file_digest(setting) == proof["sha256"]
                and json.loads(setting.read_text()).get("serverExposureMode") == "network-accessible",
                "existing network-accessible setting changed")
    require(pids == {m["listener_pid"]} and set(addresses) == set(expected),
            "pinned listener identity changed")


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
    check_listener_identity(m, listeners, port)
    # No proxies, redirects, pairing, tokens, or authenticated session creation.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(m["endpoint"] + "/.well-known/t3/environment", timeout=5) as response:
        require(response.status == 200, "environment endpoint unavailable")
        body = json.loads(response.read(65536))
    require(body.get("environmentId") == m["environment_id"], "endpoint environment changed")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Hold("environment endpoint redirected")


def current_database_snapshot(path, orphan_requests=None):
    current = pathlib.Path(path).with_name("statev2.sqlite")
    require(not current.is_symlink(), "current database is symlinked")
    if not current.exists():
        return None
    require(current.is_file(), "current database is not a file")
    with closing(sqlite3.connect(current.as_uri() + "?mode=ro", uri=True, timeout=5)) as db, db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        columns = {row[1] for row in db.execute("PRAGMA table_info(orchestration_v2_projection_runs)")}
        require("status" in columns, "current orchestration schema unavailable")
        runs = db.execute("SELECT * FROM orchestration_v2_projection_runs ORDER BY rowid").fetchall()
        statuses = db.execute("SELECT status FROM orchestration_v2_projection_runs").fetchall()
        if any(status not in ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back') for (status,) in statuses):
            raise Busy("active or unknown current orchestration run")
        settled = {
            "run_attempts": ('completed', 'interrupted', 'failed', 'cancelled', 'superseded'),
            "provider_turns": ('completed', 'interrupted', 'failed', 'cancelled'),
            "subagents": ('idle', 'completed', 'failed', 'cancelled', 'interrupted'),
            "provider_threads": ('not_loaded', 'idle', 'archived', 'closed', 'error'),
            "provider_sessions": ('ready', 'stopped', 'error'),
            "runtime_requests": ('resolved', 'expired', 'cancelled'),
            "turn_items": ('idle', 'completed', 'failed', 'cancelled', 'interrupted'),
            "nodes": ('completed', 'failed', 'cancelled', 'interrupted'),
        }
        preserved, bindings, fingerprints = {}, [], {"runs": digest(runs)}
        allowed = {name: set() for name in ('runtime_requests', 'turn_items', 'nodes')}
        prefix = "orchestration_v2_projection_"
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        require(all(prefix + name in tables for name in (*settled, 'threads', 'provider_session_bindings'))
                and 'orchestration_v2_effect_outbox' in tables, "current orchestration schema unavailable")
        pins = orphan_requests or []
        require(isinstance(pins, list) and all(isinstance(pin, dict) and set(pin) == {'thread_id', 'request_id'}
                and all(isinstance(v, str) and v for v in pin.values()) for pin in pins), "orphan pins invalid")
        require(len({pin['request_id'] for pin in pins}) == len(pins), "duplicate orphan pin")
        for pin in pins:
            thread, request_id = pin['thread_id'], pin['request_id']
            rows = db.execute("SELECT payload_json FROM " + prefix + "runtime_requests WHERE thread_id=? AND runtime_request_id=?",
                              (thread, request_id)).fetchall()
            require(len(rows) == 1, "pinned orphan request missing")
            request = json.loads(rows[0][0])
            capability = request.get('responseCapability', {}).get('type')
            require(request.get('kind') in ('command', 'file-read', 'file-change') and
                    ((request.get('status') == 'pending' and capability == 'live') or
                     (request.get('status') in ('cancelled', 'expired') and capability == 'not_resumable')),
                    "pinned request is not orphan approval")
            archived = db.execute("SELECT archived_at,deleted_at FROM " + prefix + "threads WHERE thread_id=?", (thread,)).fetchall()
            require(len(archived) == 1 and archived[0][0] is not None and archived[0][1] is None, "orphan thread is not archived")
            require(not db.execute("SELECT 1 FROM " + prefix + "provider_session_bindings WHERE thread_id=?",
                                   (thread,)).fetchall(), "orphan provider binding still exists")
            turns = db.execute("SELECT status FROM " + prefix + "provider_turns WHERE thread_id=? AND provider_turn_id=?",
                               (thread, request.get('providerTurnId'))).fetchall()
            require(turns == [('interrupted',)], "orphan provider turn is not interrupted")
            items = db.execute("SELECT payload_json FROM " + prefix + "turn_items WHERE thread_id=? AND status='waiting' AND json_extract(payload_json,'$.requestId')=?",
                               (thread, request_id)).fetchall()
            require(len(items) == 1, "orphan approval item missing or ambiguous")
            item = json.loads(items[0][0])
            require(item.get('type') == 'approval_request' and item.get('nodeId') == request.get('nodeId')
                    and item.get('providerTurnId') == request.get('providerTurnId'), "orphan approval identity differs")
            owner = db.execute("SELECT status FROM " + prefix + "runs WHERE thread_id=? AND run_id=?", (thread, item.get('runId'))).fetchall()
            require(owner == [('interrupted',)], "orphan owning run is not interrupted")
            preserved[request_id] = request['nodeId']
            allowed['runtime_requests'].add((thread, request_id))
            allowed['turn_items'].add((thread, item['id']))
            allowed['nodes'].add((thread, request['nodeId']))
            fingerprints[request_id] = digest([request, item, archived, turns, owner])
        for name, terminal in settled.items():
            table = prefix + name
            placeholders = ','.join('?' for _ in terminal)
            rows = db.execute("SELECT thread_id,payload_json FROM " + table + " WHERE status IS NULL OR status NOT IN (" + placeholders + ")", terminal).fetchall()
            for thread_id, payload in rows:
                value = json.loads(payload)
                permitted = ((thread_id, value.get('id')) in allowed.get(name, set()) and
                             ((name == 'runtime_requests' and value.get('id') in preserved and value.get('status') == 'pending')
                             or (name == 'turn_items' and value.get('requestId') in preserved and value.get('type') == 'approval_request' and value.get('status') == 'waiting')
                             or (name == 'nodes' and value.get('id') in preserved.values() and value.get('status') == 'waiting')))
                if not permitted:
                    raise Busy("active or unknown current orchestration " + name)
            fingerprints[name] = digest(rows)
        if db.execute("SELECT 1 FROM orchestration_v2_effect_outbox WHERE status IS NULL OR status NOT IN ('succeeded','failed','cancelled') LIMIT 1").fetchall():
            raise Busy("current orchestration effect pending")
        provider_rows = db.execute("SELECT thread_id,payload_json FROM " + prefix + "provider_threads ORDER BY provider_thread_id").fetchall()
        provider_ids = {row[0] for row in db.execute("SELECT provider_thread_id FROM " + prefix + "provider_threads")}
        for (payload,) in db.execute("SELECT payload_json FROM " + prefix + "subagents"):
            require(json.loads(payload).get('providerThreadId') in provider_ids, "current child native mapping unknown")
        for thread_id, payload in provider_rows:
            value = json.loads(payload)
            require(isinstance(value, dict) and value.get('pendingBackgroundTasks') == [], "current background work unknown or pending")
            native = value.get('nativeThreadRef')
            require(value.get('driver') == 'codex' and isinstance(native, dict) and native.get('driver') == 'codex'
                    and native.get('strength') == 'strong' and isinstance(native.get('nativeId'), str)
                    and native['nativeId'] and isinstance(thread_id, str) and thread_id, "current native mapping unknown")
            bindings.append({'thread_id': thread_id, 'native_id': native['nativeId']})
        fingerprints['provider_threads'] = digest(provider_rows)
        fingerprints['provider_sessions'] = digest(db.execute("SELECT * FROM " + prefix + "provider_sessions ORDER BY provider_session_id").fetchall())
        fingerprints['session_bindings'] = digest(db.execute("SELECT * FROM " + prefix + "provider_session_bindings ORDER BY provider_session_id,thread_id").fetchall())
        return {'fingerprint': digest(fingerprints), 'bindings': bindings, 'orphan_count': len(preserved)}


def database_snapshot(path, orphan_requests=None):
    current = current_database_snapshot(path, orphan_requests)
    require(pathlib.Path(path).is_file() and not pathlib.Path(path).is_symlink(), "database missing or symlinked")
    db = sqlite3.connect(pathlib.Path(path).as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        rows = lambda sql: db.execute(sql).fetchall()
        count = lambda sql: rows(sql)[0][0]
        if count("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='orchestration_v2_projection_runs'"):
            if count("SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IS NULL OR status NOT IN ('completed','interrupted','failed','cancelled','rolled_back')"):
                raise Busy("active or unknown current orchestration run")
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
        return {"pending": pending, "bindings": bindings if current is None else current['bindings'], "runtime_sha256": digest(runtime),
                "current_runs_sha256": current}
    finally:
        db.close()


def native_snapshot(m, bindings):
    sock = pathlib.Path(m["native_socket"])
    info = sock.stat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid(), "native socket ownership changed")
    request = {"socket": str(sock), "ws_require_from": m["ws_require_from"], "bindings": bindings,
               "owned_only": pathlib.Path(m['database']).with_name('statev2.sqlite').exists()}
    helper = pathlib.Path(__file__).with_name("macos-native-idle.mjs")
    try:
        result = subprocess.run([m["node"], str(helper)], input=json.dumps(request), capture_output=True, text=True, timeout=610)
    except subprocess.TimeoutExpired as error:
        native_failure(m, "helper-timeout", error.stderr)
    if result.returncode != 0:
        native_failure(m, "helper-exit:" + str(result.returncode), result.stderr)
    proof = json.loads(result.stdout)
    if proof.get("busy") is True:
        raise Busy("active native turn")
    require(proof.get("idle") is True and proof.get("bindings_checked") == len(bindings), "native idle proof incomplete")
    return proof


def native_failure(m, reason, stderr):
    parent = pathlib.Path(m["baseline_file"]).parent
    info = parent.stat()
    require(not parent.is_symlink() and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "native diagnostic directory must be private")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="native-proof-",
                                     suffix=".stderr.log", dir=parent, delete=False) as stream:
        stream.write(reason + "\n" + (stderr or ""))
    raise Hold("native read-only proof unavailable")


def observe(m):
    check_pins(m)
    before = database_snapshot(m["database"], m.get('orphan_requests'))
    native = native_snapshot(m, before["bindings"])
    after = database_snapshot(m["database"], m.get('orphan_requests'))
    require(before == after, "runtime or pending state changed during native proof")
    check_pins(m)
    return {"manifest_sha256": m["_manifest_sha256"], "environment_id": m["environment_id"],
            "state": after, "native": native}


def admit(m, capture=False):
    if m.get("active_checkpoint") is True:
        return admit_active(m, capture)
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


def admit_active(m, capture=False):
    spec = importlib.util.spec_from_file_location("active_checkpoint", pathlib.Path(__file__).with_name("macos-active-checkpoint.py"))
    checkpoint = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checkpoint)
    check_pins(m)
    state = checkpoint.snapshot(m["database"])
    check_pins(m)
    proof = {"manifest_sha256": m["_manifest_sha256"], "environment_id": m["environment_id"],
             "state": state, "native": {"checkpoint": True}}
    baseline = pathlib.Path(m["baseline_file"])
    if capture:
        require(not baseline.exists(), "baseline exists; reconcile rather than recapture")
        checkpoint.atomic_private(baseline, proof)
    else:
        previous = json.loads(private_file(baseline).read_text())
        require(previous["manifest_sha256"] == proof["manifest_sha256"] and previous["environment_id"] == proof["environment_id"],
                "active checkpoint identity changed")
        require(set(previous["state"]["threadIds"]).issubset(state["threadIds"]), "active checkpoint thread missing")
    return proof


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
        state = proof["state"]
        summary = {"admitted": True, **{key: state[key] for key in ("activeRuns", "pendingApprovals", "childAgents", "held") if key in state}}
        if "pending" in state:
            summary["pending"] = state["pending"]
        print(json.dumps(summary, sort_keys=True))
        return 0
    except (Hold, OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError) as error:
        # Never include subprocess output, database rows, conversation text or tokens.
        print("activation held: " + (str(error) if isinstance(error, Hold) else type(error).__name__), file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
