#!/usr/bin/env python3
"""Private active-update receipts. Never dispatches a prompt or answers a request."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import sqlite3
import sys
import tempfile

TABLES = ("threads", "runs", "provider_threads", "provider_turns", "provider_sessions", "runtime_requests", "turn_items", "subagents")
ACTIVE = {"preparing", "queued", "starting", "running", "waiting"}
TERMINAL = {"completed", "interrupted", "failed", "cancelled", "rolled_back"}
OPEN = {"pending", "running", "waiting", "starting"}


def snapshot(path):
    path = pathlib.Path(path)
    if path.name != "statev2.sqlite":
        path = path.with_name("statev2.sqlite")
    if not path.is_file() or path.is_symlink():
        raise ValueError("current database missing or symlinked")
    data = {}
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        for table in TABLES:
            data[table] = [dict(json.loads(payload), threadId=thread) for thread, payload in db.execute(
                "SELECT thread_id,payload_json FROM orchestration_v2_projection_" + table + " ORDER BY rowid")]
    threads = {thread["id"]: thread for thread in data["threads"]}
    providers = {thread["id"]: thread for thread in data["provider_threads"]}
    sessions = {session["id"]: session for session in data["provider_sessions"]}
    requests = [request for request in data["runtime_requests"] if request.get("status") == "pending"]
    children = [child for child in data["subagents"] if child.get("status") in OPEN]
    runs = []
    for run in data["runs"]:
        status = run.get("status")
        if status in TERMINAL:
            continue
        reasons = []
        thread = threads.get(run.get("threadId"), {})
        provider = providers.get(run.get("providerThreadId"), {})
        native = provider.get("nativeThreadRef") or {}
        session = sessions.get(provider.get("providerSessionId"), {})
        if status not in ACTIVE:
            reasons.append("unknown-run-status")
        if not thread or thread.get("archivedAt") or thread.get("deletedAt") or thread.get("settledOverride") == "settled":
            reasons.append("thread-held")
        if provider.get("driver") != "codex" or native.get("driver") != "codex" or native.get("strength") != "strong" or not native.get("nativeId"):
            reasons.append("native-mapping-unverified")
        if provider.get("ownerNodeId") is not None or provider.get("status") != "active" or not session or session.get("status") in {"stopped", "error"} or not any(turn.get("runAttemptId") == run.get("activeAttemptId") and turn.get("providerThreadId") == provider.get("id") and turn.get("status") == "running" for turn in data["provider_turns"]):
            reasons.append("runtime-not-live")
        if any(request.get("threadId") == run.get("threadId") for request in requests):
            reasons.append("pending-request")
        items = [item for item in data["turn_items"] if item.get("runId") == run["id"]]
        if any(item.get("status") in OPEN and item.get("type") in {"command_execution", "dynamic_tool", "file_change", "image_generation"} for item in items):
            reasons.append("uncertain-tool-result")
        if any(item.get("type") == "run_interrupt_request" for item in items):
            reasons.append("user-stop")
        if any(child.get("threadId") == run.get("threadId") and child.get("origin") != "app_owned" for child in children):
            reasons.append("native-child-unverified")
        if status in {"preparing", "queued", "starting", "waiting"}:
            reasons.append("run-not-live")
        runs.append({"id": run["id"], "threadId": run.get("threadId"), "status": status,
                     "decision": "held" if reasons else "continue", "reasons": reasons})
    return {"version": 1, "threadIds": sorted(threads), "knownRunIds": sorted(run["id"] for run in data["runs"]), "runs": runs,
            "activeRuns": len(runs), "pendingApprovals": len(requests), "childAgents": len(children),
            "held": sum(run["decision"] == "held" for run in runs),
            "pendingRequests": requests, "children": children,
            "completedItems": {item["id"]: hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
                               for item in data["turn_items"] if item.get("status") == "completed"}}


def atomic_private(path, payload):
    path = pathlib.Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.parent.is_symlink() or path.parent.stat().st_uid != os.getuid() or path.parent.stat().st_mode & 0o077:
        raise ValueError("checkpoint directory must be private and owned")
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        os.chmod(stream.name, 0o600)
        json.dump(payload, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(stream.name, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def write_fence(path, state):
    path = pathlib.Path(path)
    previous = json.loads(path.read_text()) if path.exists() else {}
    held = set(previous.get("heldRunIds", []))
    authorized = set(previous.get("authorizedRunIds", []))
    reasons = previous.get("heldReasons", {})
    for run in state["runs"]:
        (held if run["decision"] == "held" else authorized).add(run["id"])
        if run["decision"] == "held":
            reasons[run["id"]] = run["reasons"]
    payload = {"version": 1, "active": True, "heldRunIds": sorted(held), "heldReasons": reasons,
               "authorizedRunIds": sorted(authorized - held), "knownRunIds": state.get("knownRunIds", previous.get("knownRunIds", [])),
               "sourceThreadIds": sorted({run["threadId"] for run in state["runs"] if run.get("threadId")})}
    atomic_private(path, payload)
    return payload


def verify(before, path, fence=None):
    path = pathlib.Path(path).with_name("statev2.sqlite")
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        threads = {json.loads(row[0])["id"] for row in db.execute("SELECT payload_json FROM orchestration_v2_projection_threads")}
        runs = [json.loads(row[0]) for row in db.execute("SELECT payload_json FROM orchestration_v2_projection_runs")]
        items = {item["id"]: item for thread, payload in db.execute("SELECT thread_id,payload_json FROM orchestration_v2_projection_turn_items") for item in [dict(json.loads(payload), threadId=thread)]}
        requests = {item["id"]: item for thread, payload in db.execute("SELECT thread_id,payload_json FROM orchestration_v2_projection_runtime_requests") for item in [dict(json.loads(payload), threadId=thread)]}
    if not set(before["threadIds"]).issubset(threads):
        raise ValueError("checkpoint thread missing")
    for item_id, fingerprint in before.get("completedItems", {}).items():
        if item_id not in items or hashlib.sha256(json.dumps(items[item_id], sort_keys=True).encode()).hexdigest() != fingerprint:
            raise ValueError("confirmed checkpoint item changed or missing")
    for original in before.get("pendingRequests", []):
        current = requests.get(original["id"])
        if current is None or any(current.get(key) != original.get(key) for key in ("threadId", "nodeId", "providerTurnId", "nativeRequestRef", "kind", "createdAt")):
            raise ValueError("checkpoint approval identity missing or changed")
        if current.get("status") == "pending":
            if current != original:
                raise ValueError("pending checkpoint approval changed")
        elif current.get("status") not in {"cancelled", "expired"} or current.get("responseCapability", {}).get("type") != "not_resumable" or not current.get("responseCapability", {}).get("reason") or not current.get("resolvedAt"):
            raise ValueError("checkpoint approval not explicitly held")
    resumed = held = pending = natural = 0
    for source in before["runs"]:
        if not any(run["id"] == source["id"] for run in runs):
            raise ValueError("checkpoint source missing")
        continuations = [run for run in runs if run.get("restartContinuationOfRunId") == source["id"]]
        if len(continuations) > 1:
            raise ValueError("duplicate checkpoint continuation")
        if source["decision"] == "held" or source["id"] in (fence or {}).get("heldRunIds", []):
            if continuations:
                raise ValueError("held checkpoint was resumed")
            held += 1
        elif continuations:
            resumed += 1
        elif any(run["id"] == source["id"] and run.get("status") in {"completed", "failed"} for run in runs):
            natural += 1
        else:
            pending += 1
    return {"verified": pending == 0, "threadsPreserved": len(before["threadIds"]),
            "resumedOnce": resumed, "finishedNaturally": natural, "held": held, "pending": pending,
            "additionalHeld": len(set((fence or {}).get("heldRunIds", [])) - {run["id"] for run in before["runs"]})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=os.environ.get("T3CODE_GUARD_MANIFEST"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("guard", pathlib.Path(__file__).with_name("macos-activation-guard.py"))
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    try:
        m = guard.load_manifest(args.manifest)
        if m.get("active_checkpoint") is not True:
            print(json.dumps({"verified": True, "activeCheckpoint": False}))
            return 0
        if args.prepare:
            guard.check_pins(m)
            fence = pathlib.Path(m["database"]).parent.parent / "runtime" / "update-checkpoint.json"
            prepared = pathlib.Path(m["baseline_file"] + ".prepared")
            proof = json.loads(guard.private_file(prepared).read_text()) if prepared.exists() else guard.admit(m)
            guard.require(proof["manifest_sha256"] == m["_manifest_sha256"] and proof["environment_id"] == m["environment_id"], "prepared checkpoint identity changed")
            write_fence(fence, proof["state"])
            if not prepared.exists():
                atomic_private(prepared, proof)
            result = {"prepared": True, "activeRuns": proof["state"]["activeRuns"], "held": proof["state"]["held"]}
        else:
            before = json.loads(guard.private_file(m["baseline_file"] + ".prepared").read_text())
            guard.require(before["manifest_sha256"] == m["_manifest_sha256"] and before["environment_id"] == m["environment_id"], "prepared checkpoint identity changed")
            fence = pathlib.Path(m["database"]).parent.parent / "runtime" / "update-checkpoint.json"
            value = json.loads(guard.private_file(fence).read_text())
            result = verify(before["state"], m["database"], value)
            if result["verified"]:
                value["active"] = False
                atomic_private(fence, value)
        print(json.dumps(result, sort_keys=True))
        return 0 if result.get("verified", True) else 1
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, guard.Hold) as error:
        print("active checkpoint held: " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
