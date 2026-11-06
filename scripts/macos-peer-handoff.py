#!/usr/bin/env python3
"""One identity-pinned installed-candidate handoff; never installs or restores data."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import select
import shlex
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("peer_host", ROOT / "t3-nightly-macos-host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
g = host.guard
LABEL = "com.christinesmith.t3-fork.backend"


def owned(path):
    path = Path(path)
    g.require(path.is_file() and not path.is_symlink() and path.resolve() == path
              and path.stat().st_uid == os.getuid() and not path.stat().st_mode & 0o022,
              "peer handoff file ownership differs")
    return path


def valid_peer_command(command, home, base):
    args = shlex.split(command)
    return (len(args) == 8 and re.fullmatch(re.escape(home) + r"/\.t3/runtime/versions/[0-9][\w.+-]*/t3", args[0])
            and args[1:] == ["serve", "--host", "127.0.0.1", "--port", "3773", "--base-dir", base])


def pins(config, folder, commit, started):
    m = g.load_manifest(str(folder / "current-manifest.json"))
    g.check_pins(m)
    pid = m["listener_pid"]
    command = host.command(["/bin/ps", "-ww", "-p", str(pid), "-o", "command="])
    g.require(valid_peer_command(command, config["home"], config["baseDir"]), "listener is not an exact archive peer")
    born = time.mktime(time.strptime(host.command(["/bin/ps", "-p", str(pid), "-o", "lstart="])))
    g.require(born >= int(started) - 1, "peer predates this install attempt")
    records = []
    for record in (Path(config["baseDir"]) / "ssh-launch").iterdir():
        if record.is_dir() and not record.is_symlink():
            try:
                if all(owned(record / name).read_text().strip() == value for name, value in
                       (("pid", str(pid)), ("port", "3773"), ("managed", "managed"))):
                    records.append(str(record))
            except (OSError, g.Hold):
                continue
    g.require(len(records) == 1, "peer ownership record is ambiguous")
    destination = Path(config["home"]) / ".local/lib/t3-fork" / commit
    g.require(owned(destination / ".t3-source-commit").read_text().strip() == commit, "installed candidate differs")
    plist = owned(Path(config["home"]) / "Library/LaunchAgents" / (LABEL + ".plist"))
    wrapper = owned(Path(config["home"]) / ".local/bin/t3")
    value = plistlib.loads(plist.read_bytes())
    g.require(value.get("Label") == LABEL and value.get("ProgramArguments") == [str(wrapper), "serve", "--host", "127.0.0.1", "--port", "3773", "--base-dir", config["baseDir"]]
              and value.get("EnvironmentVariables", {}).get("T3_FORK_DEPLOYMENT_COMMIT") == commit
              and str(destination / "dist/bin.mjs") in wrapper.read_text(), "installed service configuration differs")
    return dict(identity=g.process_identity(pid), record=records[0], destination=str(destination),
                plist_sha256=g.file_digest(plist), wrapper_sha256=g.file_digest(wrapper))


def plan(config, folder, commit, started):
    value = pins(config, folder, commit, started)
    root = Path(config["backupRoot"])
    candidates = [p for p in root.glob("*-" + commit[:12]) if p.is_dir() and not p.is_symlink()
                  and p.stat().st_uid == os.getuid() and p.stat().st_birthtime >= int(started) - 1]
    g.require(len(candidates) == 1, "one cold backup from this attempt is required")
    backup = candidates[0]
    for name in ("state.sqlite", "statev2.sqlite"):
        path = owned(backup / name)
        with sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True) as db:
            g.require(db.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "cold rollback integrity differs")
    value.update(commit=commit, started=started, backup=str(backup))
    path = folder / "peer-recovery.json"
    with path.open("x") as stream:
        json.dump(value, stream)
    path.chmod(0o600)
    return value


def resume_exact(identity):
    try:
        if g.process_identity(identity["pid"]) == identity:
            os.kill(identity["pid"], signal.SIGCONT)
            return True
    except (OSError, g.Hold, subprocess.CalledProcessError):
        pass
    return False


def verify_clock(config):
    before = time.time()
    observed = int(subprocess.check_output(["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                                           config["millie"]["ssh"], "/bin/date +%s"], text=True, timeout=8))
    after = time.time()
    g.require(after - before <= 5 and before - 2 <= observed <= after + 2,
              "peer clocks or transport latency cannot support the bounded handoff")


def watch(path, owner):
    plan = json.loads(g.private_file(path).read_text())
    queue = select.kqueue()
    try:
        queue.control([select.kevent(owner, filter=select.KQ_FILTER_PROC,
                       flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_ONESHOT,
                       fflags=select.KQ_NOTE_EXIT)], 1, max(0, min(75, plan["resumeAt"] - time.monotonic())))
    except ProcessLookupError:
        pass
    if not path.with_suffix(".remote-finished").exists():
        select.select([], [], [], max(0, min(75, plan["resumeAt"] - time.monotonic())))
    g.require(resume_exact(plan["identity"]), "watchdog main identity changed; no signal sent")
    print("exact desktop main resumed by independent watchdog")


def coordinate(config, folder, remote, commit):
    host.gate(config["elora"], folder)
    m = g.load_manifest(str(folder / "current-manifest.json"))
    pid = int(host.command(["/bin/ps", "-p", str(m["listener_pid"]), "-o", "ppid="]))
    app = Path(config["elora"].get("appPath", "/Applications/T3 Code (Alpha).app"))
    executable = app / "Contents/MacOS" / plistlib.loads(owned(app / "Contents/Info.plist").read_bytes())["CFBundleExecutable"]
    command = host.command(["/bin/ps", "-ww", "-p", str(pid), "-o", "command="])
    g.require(command == str(executable), "backend parent is not the exact desktop main")
    identity = g.process_identity(pid)
    g.require(identity["uid"] == os.getuid(), "desktop main owner differs")
    rows = [line.split(None, 2) for line in host.command(["/bin/ps", "-axo", "pid=,ppid=,command="]).splitlines()]
    descendants = {pid}
    for _ in rows:
        descendants.update(int(row[0]) for row in rows if len(row) == 3 and int(row[1]) in descendants)
    g.require(not any(int(row[0]) in descendants and "ssh" in row[2]
                      and any(flag in row[2] for flag in ("sh -s", "run-t3.next.")) for row in rows if len(row) == 3),
              "peer startup is already in flight")
    verify_clock(config)
    path = folder / "desktop-main-pause.json"
    remote_deadline = time.time() + 70
    resume_at = time.monotonic() + 75
    with path.open("x") as stream:
        json.dump({"identity": identity, "resumeAt": resume_at}, stream)
    path.chmod(0o600)
    with (folder / "desktop-main-watchdog.log").open("xb") as log:
        watchdog = subprocess.Popen(["/usr/bin/python3", str(Path(__file__).resolve()), "watch", str(path), str(os.getpid())],
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    paused = False
    try:
        g.require(g.process_identity(pid) == identity, "desktop main changed at pause boundary")
        os.kill(pid, signal.SIGSTOP)
        paused = True
        args = ["/usr/bin/python3", remote + "/control/macos-peer-handoff.py", "recover", remote + "/config.json", remote, commit, str(remote_deadline)]
        output = subprocess.check_output(["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                                          config["millie"]["ssh"], " ".join(shlex.quote(a) for a in args)], text=True, timeout=80)
        result = json.loads(output)
        g.require(result.get("commitPrefix") == commit, "remote handoff receipt differs")
        path.with_suffix(".remote-finished").touch(mode=0o600)
        return dict(result, watchdogPid=watchdog.pid)
    finally:
        if paused:
            if not path.with_suffix(".remote-finished").exists():
                select.select([], [], [], max(0, min(75, resume_at - time.monotonic())))
            g.require(resume_exact(identity), "desktop main changed; independent watchdog remains armed")


def recover(config, folder, commit, expires=None):
    expires = time.time() + 75 if expires is None else expires
    g.require(0 < expires - time.time() <= 90, "peer recovery window expired")
    stop_at = time.monotonic() + expires - time.time()
    saved = json.loads(g.private_file(folder / "peer-recovery.json").read_text())
    g.require(saved["commit"] == commit, "recovery source differs")
    host.gate(config, folder)
    current = pins(config, folder, commit, saved["started"])
    g.require(all(current[key] == saved[key] for key in current), "peer recovery pins changed")
    rows = host.command(["/bin/ps", "-axo", "pid=,command="]).splitlines()
    g.require(not any(Path(saved["record"]).name in row and ("sh -s" in row or "run-t3.next." in row) for row in rows),
              "remote peer startup is in flight")
    pid = saved["identity"]["pid"]
    queue = select.kqueue()
    queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_ONESHOT,
                                fflags=select.KQ_NOTE_EXIT)], 0, 0)
    g.require(g.process_identity(pid) == saved["identity"], "peer changed at stop boundary")
    g.require(time.monotonic() + 45 < stop_at, "insufficient bounded handoff window; no signal sent")
    os.kill(pid, signal.SIGTERM)
    g.require(bool(queue.control(None, 1, 10)), "exact peer did not exit")
    g.require(time.monotonic() < stop_at, "handoff window expired before service start")
    try:
        subprocess.run(["/bin/launchctl", "kickstart", "gui/" + str(os.getuid()) + "/" + LABEL], check=True, timeout=20)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
        pass
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and time.monotonic() < stop_at:
        try:
            job = host.command(["/bin/launchctl", "print", "gui/" + str(os.getuid()) + "/" + LABEL])
            match = re.search(r"^\s*pid = ([0-9]+)$", job, re.MULTILINE)
            if match:
                owner = int(match.group(1))
                entry = str(Path(saved["destination"]) / "dist/bin.mjs")
                argv = shlex.split(host.command(["/bin/ps", "-ww", "-p", str(owner), "-o", "command="]))
                g.require(argv == [config["node"], entry, "serve", "--host", "127.0.0.1", "--port", "3773", "--base-dir", config["baseDir"]],
                          "candidate service command differs")
                raw = host.command(["/usr/sbin/lsof", "-nP", "-a", "-iTCP:3773", "-sTCP:LISTEN", "-Fpn"])
                g.check_listener_identity({"listener_pid": owner}, raw, "3773")
                with urllib.request.urlopen("http://127.0.0.1:3773/.well-known/t3/environment", timeout=2) as response:
                    g.require(json.load(response)["environmentId"] == config["environmentId"], "candidate environment differs")
                return dict(commitPrefix=commit, candidatePid=owner, terminatedPeerPid=pid)
        except (OSError, subprocess.CalledProcessError):
            pass
        time.sleep(0.25)
    raise g.Hold("installed candidate ownership was not established; no reinstall attempted")


if __name__ == "__main__":
    try:
        operation = sys.argv[1]
        if operation == "watch":
            watch(Path(sys.argv[2]), int(sys.argv[3]))
        else:
            configuration = json.loads(g.private_file(sys.argv[2]).read_text())
            folder = Path(sys.argv[3])
            if operation == "coordinate":
                result = coordinate(configuration, folder, sys.argv[4], sys.argv[5])
            elif operation == "plan":
                result = plan(configuration["millie"], folder, sys.argv[4], float(sys.argv[5]))
            elif operation == "recover":
                result = recover(configuration["millie"], folder, sys.argv[4], float(sys.argv[5]))
            else:
                raise g.Hold("unknown peer recovery operation")
            print(json.dumps(result))
    except Exception as error:
        print("peer handoff held: " + (str(error) if isinstance(error, g.Hold) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
