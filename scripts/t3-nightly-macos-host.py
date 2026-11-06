#!/usr/bin/env python3
"""Fixed no-model host operations for the macOS nightly controller."""
import importlib.util
import json
import os
import re
from pathlib import Path
import plistlib
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("activation_guard", ROOT / "macos-activation-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def command(argv, env=None):
    controls = Path.home() / "Codex_Workroom/task_evidence/otis-control"
    guard.require(not any((controls / name).exists() for name in ("STOP-ALL", "STOP-t3-nightly-sync")),
                  "nightly update is stopped")
    return subprocess.check_output(argv, text=True, env=env, timeout=7200).strip()


def versions(host):
    value = json.loads(command([str(Path(host["home"]) / ".local/bin/codex"),
                                "app-server", "daemon", "version"]))
    guard.require(value.get("status") == "running" and value.get("appServerVersion")
                  and value["appServerVersion"] == value.get("managedCodexVersion"),
                  "managed Codex daemon version is unavailable or differs")


def capture(host, folder):
    guard.require(socket.gethostname() == host["hostname"] and str(Path.home()) == host["home"],
                  "nightly host identity changed")
    versions(host)
    endpoint = "http://127.0.0.1:3773"
    raw = command(["/usr/sbin/lsof", "-nP", "-a", "-iTCP:3773", "-sTCP:LISTEN", "-Fpn"])
    pids = {int(line[1:]) for line in raw.splitlines() if line.startswith("p")}
    guard.require(len(pids) == 1, "one exact listener required")
    pid = next(iter(pids))
    identity = host.get("identityFile", str(Path(host["sourceRoot"]) / "package.json"))
    websocket = [ROOT / "node_modules/ws/package.json"] if (ROOT / "node_modules/ws/package.json").is_file() else list((Path(host["sourceRoot"]) / "node_modules/.pnpm").glob("ws@8*/node_modules/ws/package.json"))
    guard.require(len(websocket) == 1, "one supported native websocket dependency is required")
    manifest = dict(version=1, task="T-Z9T3", active_checkpoint=True, hostname=host["hostname"],
                    user=Path.home().name, home=host["home"], expires_at=time.time() + 7200,
                    environment_id=host["environmentId"], endpoint=endpoint,
                    database=str(Path(host["baseDir"]) / "userdata/state.sqlite"),
                    environment_file=str(Path(host["baseDir"]) / "userdata/environment-id"),
                    processes=[guard.process_identity(pid)], listener_pid=pid,
                    listener_addresses=host["listenerAddresses"], source_root=host["sourceRoot"],
                    commit=command(["git", "-C", host["sourceRoot"], "rev-parse", "HEAD"]),
                    candidate_identity_file=identity, candidate_identity_sha256=guard.file_digest(identity),
                    allocation_bytes=1024 * 1024, baseline_file=str(folder / ("baseline-" + uuid.uuid4().hex + ".json")),
                    node=host["node"], ws_require_from=str(websocket[0]), native_socket=host["nativeSocket"])
    if "*:3773" in host["listenerAddresses"]:
        setting = Path(host["baseDir"]) / "userdata/desktop-settings.json"
        manifest["network_config"] = dict(path=str(setting), sha256=guard.file_digest(setting))
    path = folder / "current-manifest.json"
    path.write_text(json.dumps(manifest))
    path.chmod(0o600)
    state = guard.admit(guard.load_manifest(str(path)), capture=True)
    return state


def gate(host, folder):
    versions(host)
    manifest = guard.load_manifest(str(folder / "current-manifest.json"))
    guard.require(manifest.get("active_checkpoint") is True, "active checkpoint admission required")
    return guard.admit(manifest)


def admission_summary(proof):
    state = proof["state"]
    result = {key: state[key] for key in ("activeRuns", "pendingApprovals", "childAgents", "held")}
    guard.require(all(type(value) is int and value >= 0 for value in result.values()),
                  "active checkpoint counts unavailable")
    return dict(result, admitted=True)


def preserve_checkpoint(folder):
    source = guard.private_file(folder / "current-manifest.json")
    target = folder / "checkpoint-manifest.json"
    if target.exists():
        guard.require(guard.private_file(target).read_bytes() == source.read_bytes(),
                      "prior checkpoint requires reconciliation")
    else:
        with target.open("xb") as stream:
            os.chmod(target, 0o600)
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        descriptor = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def verify_checkpoint(folder):
    proof = json.loads(command(["/usr/bin/python3", str(ROOT / "macos-active-checkpoint.py"),
                                "--manifest", str(folder / "checkpoint-manifest.json"), "--verify"]))
    guard.require(proof.get("verified") is True, "active checkpoint recovery unverified")
    return proof


def backend_args(host, folder, commit):
    m = json.loads((folder / "current-manifest.json").read_text())
    argv = shlex.split(command(["/bin/ps", "-ww", "-p", str(m["listener_pid"]), "-o", "command="]))
    entries = [item for item in argv if item.endswith("/dist/bin.mjs")]
    guard.require(len(entries) == 1, "exact installed backend entry unavailable")
    return [host["node"], str(ROOT / "deploy-macos-backend.mjs"), "--candidate", str(folder / "candidate"),
            "--commit", commit, "--node", host["node"], "--old-node", argv[0], "--old-entry", entries[0],
            "--expected-old-pid", str(m["listener_pid"]), "--base-dir", host["baseDir"],
            "--backup-root", host["backupRoot"], "--smoke-home", str(folder / "smoke")]


def installed(host, name, folder):
    manifest = guard.load_manifest(str(folder / "current-manifest.json"))
    guard.check_pins(manifest)
    process_command = command(["/bin/ps", "-ww", "-p", str(manifest["listener_pid"]), "-o", "command="])
    argv = shlex.split(process_command)
    if name == "millie":
        entries = [item for item in argv if re.fullmatch(re.escape(host["home"]) + r"/\.local/lib/t3-fork/[0-9a-f]{40}/dist/bin\.mjs", item)]
        guard.require(len(entries) == 1, "installed backend entry is uncertain")
        prefix = Path(entries[0]).parent.parent.name
        guard.require((Path(entries[0]).parent.parent / ".t3-source-commit").read_text().strip() == prefix,
                      "installed backend source marker differs")
    else:
        app = Path(host.get("appPath", "/Applications/T3 Code (Alpha).app"))
        asar = app / "Contents/Resources/app.asar"
        executable = plistlib.loads((app / "Contents/Info.plist").read_bytes())["CFBundleExecutable"]
        guard.require(process_command.startswith(str(app / "Contents/MacOS" / executable) + " ")
                      and str(asar / "apps/server/dist/bin.mjs") + " " in process_command,
                      "installed desktop backend entry is uncertain")
        start = time.mktime(time.strptime(command(["/bin/ps", "-p", str(manifest["listener_pid"]), "-o", "lstart="])))
        guard.require(asar.stat().st_mtime <= start + 1, "desktop archive changed after its backend started")
        script = "const a=require('node:module').createRequire(process.argv[1])('@electron/asar');console.log(JSON.parse(a.extractFile(process.argv[2],'package.json')).t3codeCommitHash)"
        prefix = command([host["node"], "-e", script, str(Path(host["sourceRoot"]) / "scripts/package.json"), str(asar)])
        guard.require(re.fullmatch(r"[0-9a-f]{12,40}", prefix), "installed desktop source marker unavailable")
    return {"commitPrefix": prefix}


def prepare(host, folder, commit):
    guard.require((folder / "candidate/.t3-source-commit").read_text().strip() == commit, "candidate commit differs")
    node = Path(host["node"])
    env = dict(os.environ, PATH=str(node.parent) + ":" + os.environ.get("PATH", ""),
               VITE_OTIS_ENABLED="false", VITE_OTIS_CALL_ENABLED="false")
    command(backend_args(host, folder, commit) + ["--dry-run"], env)


def deploy(host, name, folder, commit, app=None):
    gate(host, folder)
    preserve_checkpoint(folder)
    env = dict(os.environ, PATH=str(Path(host["node"]).parent) + ":" + os.environ.get("PATH", ""),
               T3_NIGHTLY_CONFIG=str(CONFIG), T3_NIGHTLY_HOST=name, T3_NIGHTLY_FOLDER=str(folder),
               T3CODE_GUARD_MANIFEST=str(folder / "current-manifest.json"),
               T3CODE_PRESTOP_GUARD=str(Path(__file__).resolve()))
    if name == "elora":
        env["T3CODE_PREPARED_APP"] = app
        args = ["/bin/bash", str(Path(host["sourceRoot"]) / "scripts/launch-t3-code-macos.sh"),
                "--expected-branch", CONFIGURATION["branch"], "--expected-commit", commit,
                "--backup-root", host["backupRoot"], "--artifact-dir", str(folder / "activation"),
                "--skip-build", "--headless-rollback"]
    else:
        args = backend_args(host, folder, commit) + ["--execute"]
    maintenance_hold = False
    attempted_at = time.time()
    try:
        command(args, env)
    except subprocess.CalledProcessError:
        maintenance_hold = True
    capture(host, folder)
    try:
        proof = installed(host, name, folder)
    except guard.Hold:
        if name != "millie" or not maintenance_hold:
            raise
        command(["/usr/bin/python3", str(ROOT / "macos-peer-handoff.py"), "plan", str(CONFIG),
                 str(folder), commit, str(attempted_at)])
        return {"peerRecoveryRequired": True}
    guard.require(commit.startswith(proof["commitPrefix"]), "deployment did not prove the requested installed source")
    versions(host)
    return dict(proof, maintenanceHold=maintenance_hold, recovery=verify_checkpoint(folder))


def accept_recovered(host, folder, commit):
    capture(host, folder)
    proof = installed(host, "millie", folder)
    guard.require(commit == proof["commitPrefix"], "recovered installed source differs")
    pending = json.loads(guard.private_file(folder / "peer-recovery.json").read_text())
    backup = Path(pending["backup"])
    guard.require(pending["commit"] == commit and backup.parent == Path(host["backupRoot"])
                  and not backup.is_symlink(), "recovered rollback receipt differs")
    versions(host)
    maintenance_hold = False
    try:
        script = "const m=await import(process.argv[1]);await m.retirePreviousRollback(process.argv[2],process.argv[3]);"
        command([host["node"], "--input-type=module", "-e", script, str(ROOT / "deploy-macos-backend.mjs"),
                 host["backupRoot"], str(backup)])
    except subprocess.CalledProcessError:
        maintenance_hold = True
    return dict(proof, maintenanceHold=maintenance_hold, recovery=verify_checkpoint(folder))


def maintenance(host, name):
    root = Path(host["backupRoot"])
    if name == "elora":
        path = root / ".t3code-macos-deployment-state"
        if not path.exists():
            return
        state = dict(line.split("=", 1) for line in guard.private_file(path).read_text().splitlines())
        guard.require(state.get("phase") == "accepted", "unfinished desktop installation requires reconciliation")
        guard.require(Path(state["run_dir"]).parent == root and state["app_path"] == host.get("appPath", "/Applications/T3 Code (Alpha).app"),
                      "accepted retirement receipt changed")
        command(["/usr/bin/python3", str(ROOT / "macos-storage.py"), "retire", state["run_dir"],
                 state["previous_app"], "--app", state["app_path"]])
        path.unlink()
    else:
        path = root / "pending-rollback-retirement.json"
        if not path.exists():
            return
        pending = json.loads(guard.private_file(path).read_text())
        guard.require(Path(pending["current"]).parent == root, "pending retirement root changed")
        script = "const m=await import(process.argv[2]);await m.retirePreviousRollback(process.argv[3],process.argv[4]);"
        command([host["node"], "--input-type=module", "-e", script, "retirement-only", str(ROOT / "deploy-macos-backend.mjs"),
                 str(root), pending["current"]])


def note(line):
    token = os.environ.get("CODEXDECK_TOKEN", "").strip()
    if not token:
        path = Path.home() / ".codexdeck/agent_token"
        if path.exists():
            token = path.read_text().strip()
        else:
            token = json.loads((Path.home() / ".codexdeck/token").read_text()).get("agent", "")
    guard.require(bool(token), "local history authorization unavailable")
    data = json.dumps({"task": "T-Z9T3", "note": line}).encode()
    request = urllib.request.Request("http://127.0.0.1:8787/api/v1/update", data=data,
                                     headers={"X-Deck-Token": token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.loads(response.read())
        guard.require(response.status == 200 and not value.get("error"), "history note not accepted")


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--gate-only"]:
            CONFIG = Path(os.environ["T3_NIGHTLY_CONFIG"])
            CONFIGURATION = json.loads(guard.private_file(CONFIG).read_text())
            gate(CONFIGURATION[os.environ["T3_NIGHTLY_HOST"]], Path(os.environ["T3_NIGHTLY_FOLDER"]))
        else:
            CONFIG = Path(sys.argv[1])
            CONFIGURATION = json.loads(guard.private_file(CONFIG).read_text())
            name, operation, folder = sys.argv[2], sys.argv[3], Path(sys.argv[4])
            host = CONFIGURATION[name]
            if operation == "note":
                note(sys.argv[5])
            elif operation == "capture":
                print(json.dumps(admission_summary(capture(host, folder))))
            elif operation == "prepare":
                prepare(host, folder, sys.argv[5])
            elif operation == "installed":
                print(json.dumps(installed(host, name, folder)))
            elif operation == "maintenance":
                maintenance(host, name)
            elif operation == "deploy":
                print(json.dumps(deploy(host, name, folder, sys.argv[5], sys.argv[6] if len(sys.argv) > 6 else None)))
            elif operation == "accept-recovered":
                print(json.dumps(accept_recovered(host, folder, sys.argv[5])))
            elif operation == "cleanup":
                guard.require(folder.parent == Path(host["home"]) / ".local/share/t3-nightly"
                              and folder.name.startswith("run-") and not folder.is_symlink(),
                              "build cleanup root differs")
                candidate = folder / "candidate"
                guard.require(candidate.is_dir() and not candidate.is_symlink()
                              and (candidate / ".t3-source-commit").is_file(), "owned build marker unavailable")
                shutil.rmtree(candidate)
            else:
                raise guard.Hold("unknown nightly host operation")
        if sys.argv[1:] == ["--gate-only"] or operation not in ("installed", "deploy", "accept-recovered"):
            print("nightly host step passed")
    except Exception as error:
        print("nightly host step held: " + (str(error) if isinstance(error, guard.Hold) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
