"""Small local fixtures. No production state, network, models or schedules."""
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import runpy
import tempfile
import unittest
from unittest.mock import patch, call
import signal
import sys
from contextlib import ExitStack, redirect_stdout, redirect_stderr
from types import SimpleNamespace


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


lock = module("nightly_lock", "t3-nightly-macos-lock.py")
archive = module("nightly_archive", "macos-rollback-archive.py")
host = module("nightly_host", "t3-nightly-macos-host.py")
peer = module("nightly_peer", "macos-peer-handoff.py")


class NightlyTests(unittest.TestCase):
    def test_host_cli_json_operations_emit_one_complete_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            commit = "a" * 40
            folder = root / "run-11111111-1111-1111-1111-111111111111"
            folder.mkdir()
            prior = root / "run-22222222-2222-2222-2222-222222222222"
            prior.mkdir()
            entry = root / ".local/lib/t3-fork" / commit / "dist/bin.mjs"
            entry.parent.mkdir(parents=True)
            entry.parent.parent.joinpath(".t3-source-commit").write_text(commit)
            source = root / "source"
            websocket = source / "node_modules/.pnpm/ws@8.0.0/node_modules/ws/package.json"
            websocket.parent.mkdir(parents=True)
            websocket.write_text("{}")
            settings = dict(hostname="fixture", home=str(root), sourceRoot=str(source),
                            environmentId="fixture", baseDir=str(root / ".t3"),
                            listenerAddresses=["127.0.0.1:3773"], node="/node",
                            nativeSocket="/private/fixture", backupRoot=str(root / "backups"))
            config = root / "config.json"
            config.write_text(json.dumps({"millie": settings}))
            config.chmod(0o600)
            pending = folder / "peer-recovery.json"
            pending.write_text(json.dumps({"commit": commit, "backup": str(root / "backups/current")}))
            pending.chmod(0o600)
            counts = dict(activeRuns=1, pendingApprovals=1, childAgents=1, held=0)
            recovery = dict(verified=True, resumed=1)
            installed = dict(commitPrefix=commit)

            def command(argv, **kwargs):
                if argv[0] == str(root / ".local/bin/codex"):
                    return json.dumps(dict(status="running", appServerVersion="fixture", managedCodexVersion="fixture"))
                if argv[0] == "/usr/sbin/lsof":
                    return "p123\nn127.0.0.1:3773"
                if argv[0] == "git":
                    return commit
                if argv[0] == "/bin/ps":
                    return "/node " + str(entry)
                if argv[0] == "/usr/bin/python3" and argv[-1] == "--verify":
                    return json.dumps(recovery)
                if argv[0] == "/node":
                    return ""
                raise AssertionError("unexpected host command: " + repr(argv))

            operations = [
                ("capture", [], dict(counts, admitted=True)),
                ("installed", [], installed),
                ("reconcile", [prior.name, commit], dict(installed, recovery=recovery)),
                ("deploy", [commit], dict(installed, maintenanceHold=False, recovery=recovery)),
                ("accept-recovered", [commit], dict(installed, maintenanceHold=False, recovery=recovery)),
            ]
            script = Path(__file__).with_name("t3-nightly-macos-host.py")
            for operation, arguments, expected in operations:
                with self.subTest(operation=operation), ExitStack() as stack:
                    stack.enter_context(patch.object(sys, "argv", [str(script), str(config), "millie", operation, str(folder), *arguments]))
                    stack.enter_context(patch.object(Path, "home", return_value=root))
                    stack.enter_context(patch.object(host.socket, "gethostname", return_value="fixture"))
                    stack.enter_context(patch.object(host.subprocess, "check_output", side_effect=command))
                    stack.enter_context(patch.object(host.guard, "load_manifest", side_effect=lambda path: json.loads(Path(path).read_text())))
                    stack.enter_context(patch.object(host.guard, "check_pins"))
                    stack.enter_context(patch.object(host.guard, "admit", return_value={"state": counts}))
                    stack.enter_context(patch.object(host.guard, "process_identity", return_value={"pid": 123}))
                    stack.enter_context(patch.object(host.guard, "file_digest", return_value="fixture"))
                    stack.enter_context(patch.object(importlib.util, "spec_from_file_location", return_value=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))))
                    stack.enter_context(patch.object(importlib.util, "module_from_spec", return_value=host.guard))
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        runpy.run_path(str(script), run_name="__main__")
                    self.assertEqual(stderr.getvalue(), "")
                    self.assertEqual(json.loads(stdout.getvalue()), expected)

    def test_peer_recovery_expired_window_refuses_any_signal(self):
        with patch.object(peer.os, "kill") as send, patch.object(peer.host, "gate") as gate:
            with self.assertRaises(peer.g.Hold):
                peer.recover({}, Path("/unused"), "a" * 40, expires=0)
            send.assert_not_called()
            gate.assert_not_called()

    def test_peer_clock_skew_holds_before_pause(self):
        with patch.object(peer.time, "time", side_effect=[100, 101]), patch.object(peer.subprocess, "check_output", return_value="200\n"), patch.object(peer.os, "kill") as send:
            with self.assertRaises(peer.g.Hold):
                peer.verify_clock({"millie": {"ssh": "millie-codex"}})
            send.assert_not_called()

    def test_peer_watchdog_wait_is_bounded_by_resume_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "desktop-main-pause.json"
            path.write_text(json.dumps({"identity": {"pid": 123}, "resumeAt": 175}))
            path.chmod(0o600)
            queue = SimpleNamespace(control=lambda changes, count, timeout: self.assertLessEqual(timeout, 75))
            with patch.object(peer.select, "kqueue", return_value=queue), patch.object(peer.time, "monotonic", return_value=100), patch.object(peer.select, "select") as deadline_wait, patch.object(peer, "resume_exact", return_value=True):
                peer.watch(path, 999)
                deadline_wait.assert_called_once_with([], [], [], 75)

    def test_peer_coordinator_resumes_exact_main_when_remote_handoff_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            app = root / "T3 Code.app"
            (app / "Contents").mkdir(parents=True)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "T3 Code"}))
            executable = str(app / "Contents/MacOS/T3 Code")
            identity = {"pid": 123, "uid": os.getuid(), "started": "fixture", "command_sha256": "fixture"}
            def command(argv):
                if argv[-1] == "ppid=":
                    return "123"
                if argv[-1] == "command=":
                    return executable
                return "123 1 " + executable
            config = {"elora": {"appPath": str(app)}, "millie": {"ssh": "millie-codex"}}
            with patch.object(peer.host, "gate"), patch.object(peer.g, "load_manifest", return_value={"listener_pid": 124}), patch.object(peer.host, "command", side_effect=command), patch.object(peer.g, "process_identity", return_value=identity), patch.object(peer, "verify_clock"), patch.object(peer.subprocess, "Popen", return_value=SimpleNamespace(pid=999)), patch.object(peer.subprocess, "check_output", side_effect=OSError("remote failed")), patch.object(peer.select, "select", return_value=([], [], [])) as deadline_wait, patch.object(peer.os, "kill") as send:
                with self.assertRaises(OSError):
                    peer.coordinate(config, root, "/remote/run", "a" * 40)
                self.assertEqual(send.call_args_list, [call(123, signal.SIGSTOP), call(123, signal.SIGCONT)])
                deadline_wait.assert_called_once()

    def test_peer_recovery_changed_identity_refuses_any_signal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "peer-recovery.json"
            path.write_text(json.dumps({"commit": "a" * 40, "started": 1, "identity": {"pid": 123}}))
            path.chmod(0o600)
            with patch.object(peer.host, "gate"), patch.object(peer, "pins", return_value={"identity": {"pid": 124}}), patch.object(peer.os, "kill") as send:
                with self.assertRaises(peer.g.Hold):
                    peer.recover({}, root, "a" * 40)
                send.assert_not_called()

    def test_peer_handoff_accepts_only_exact_archive_command_and_resumes_only_same_identity(self):
        home = "/Users/millie"
        base = home + "/.t3"
        command = home + "/.t3/runtime/versions/0.1.7/t3 serve --host 127.0.0.1 --port 3773 --base-dir " + base
        self.assertTrue(peer.valid_peer_command(command, home, base))
        for invalid in (command.replace("3773", "3774"), command.replace("/Users/millie/.t3/runtime", "/tmp/runtime"), command + " --other"):
            self.assertFalse(peer.valid_peer_command(invalid, home, base))
        identity = {"pid": 123, "uid": os.getuid(), "started": "fixture", "command_sha256": "fixture"}
        with patch.object(peer.g, "process_identity", return_value=identity), patch.object(peer.os, "kill") as send:
            self.assertTrue(peer.resume_exact(identity))
            send.assert_called_once_with(123, signal.SIGCONT)
        with patch.object(peer.g, "process_identity", return_value={**identity, "started": "changed"}), patch.object(peer.os, "kill") as send:
            self.assertFalse(peer.resume_exact(identity))
            send.assert_not_called()

    def test_desktop_installed_proof_preserves_spaces_in_exact_process_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "T3 Code.app"
            (app / "Contents/Resources").mkdir(parents=True)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "T3 Code (Beta)"}))
            (app / "Contents/Resources/app.asar").write_bytes(b"fixture")
            process = str(app / "Contents/MacOS/T3 Code (Beta)") + " --require helper " + str(app / "Contents/Resources/app.asar/apps/server/dist/bin.mjs") + " --bootstrap-fd 3"
            def command(argv):
                if argv[0] == "/bin/ps":
                    return process if argv[-1] == "command=" else "Tue Nov 05 23:00:00 2030"
                return "a" * 12
            with patch.object(host.guard, "load_manifest", return_value={"listener_pid": 123}), patch.object(host.guard, "check_pins"), patch.object(host, "command", side_effect=command):
                self.assertEqual(host.installed({"appPath": str(app), "node": "/node", "sourceRoot": "/source"}, "elora", Path(directory)), {"commitPrefix": "a" * 12})

    def test_os_lock_releases_after_owner_descriptor_closes(self):
        with tempfile.TemporaryDirectory() as directory:
            first = lock.acquire(directory)
            with self.assertRaises(BlockingIOError):
                lock.acquire(directory)
            os.close(first)
            second = lock.acquire(directory)
            os.close(second)

    def test_active_gate_uses_checkpoint_admission_without_an_idle_precondition(self):
        manifest = {"active_checkpoint": True}
        proof = {"activeRuns": 1, "pendingApprovals": 1, "childAgents": 1}
        with patch.object(host, "current_idle", create=True, side_effect=AssertionError("idle gate")), patch.object(host.guard, "load_manifest", return_value=manifest), patch.object(host.guard, "admit", return_value=proof) as admit, patch.object(host, "versions"):
            self.assertEqual(host.gate({"baseDir": "/unused"}, Path("/private/run")), proof)
            admit.assert_called_once_with(manifest)

    def test_checkpoint_manifest_survives_new_listener_capture_and_rejects_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            current = root / "current-manifest.json"
            current.write_text(json.dumps({"listener_pid": 123, "baseline_file": "/private/before.json"}))
            current.chmod(0o600)
            host.preserve_checkpoint(root)
            host.preserve_checkpoint(root)
            current.write_text(json.dumps({"listener_pid": 124, "baseline_file": "/private/after.json"}))
            checkpoint = root / "checkpoint-manifest.json"
            self.assertEqual(json.loads(checkpoint.read_text())["listener_pid"], 123)
            with self.assertRaises(host.guard.Hold):
                host.preserve_checkpoint(root)
            self.assertEqual(checkpoint.stat().st_mode & 0o777, 0o600)

    def test_capture_summary_requires_counts_and_recovery_requires_explicit_verification(self):
        counts = {"activeRuns": 1, "pendingApprovals": 1, "childAgents": 1, "held": 1}
        self.assertEqual(host.admission_summary({"state": counts}), dict(counts, admitted=True))
        with patch.object(host, "command", return_value=json.dumps({"resumed": 1})):
            with self.assertRaises(host.guard.Hold):
                host.verify_checkpoint(Path("/private/run"))
        with patch.object(host, "command", return_value=json.dumps({"verified": True, "resumed": 1})):
            self.assertTrue(host.verify_checkpoint(Path("/private/run"))["verified"])

    def test_local_archive_is_recoverable_and_reuses_only_identical_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "original"
            source.mkdir()
            (source / "state.sqlite").write_bytes(b"synthetic saved data")
            target = archive.archive(source, "elora", "20261105-030000-123", archive_root=root / "archive")
            self.assertTrue(source.is_dir())
            self.assertEqual(archive.inventory(source), archive.inventory(target))
            self.assertEqual(archive.archive(source, "elora", "20261105-030000-123", archive_root=root / "archive"), target)
            (source / "state.sqlite").write_bytes(b"changed")
            with self.assertRaises(RuntimeError):
                archive.archive(source, "elora", "20261105-030000-123", archive_root=root / "archive")
            self.assertEqual((target / "state.sqlite").read_bytes(), b"synthetic saved data")

    def test_rollback_retention_keeps_newest_healthy_and_receipts(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / "archive"
            for name in ("20261105-030000-123", "20261106-030000-123"):
                receipt = root / "millie" / name
                payload = receipt / "rollback"
                payload.mkdir(parents=True)
                with sqlite3.connect(payload / "state.sqlite") as db:
                    db.execute("CREATE TABLE saved(value TEXT)")
                (receipt / "rollback.inventory.json").write_text(json.dumps({"source": str(payload), "sha256": archive.inventory(payload)}))
            newest = root / "millie/20261107-030000-123"
            (newest / "rollback").mkdir(parents=True)
            (newest / "rollback/state.sqlite").write_bytes(b"incomplete")
            result = archive.prune(root, "millie", apply=True, probe=lambda path: None)
            self.assertEqual(result["kept"], "20261106-030000-123")
            self.assertFalse((root / "millie/20261105-030000-123/rollback").exists())
            self.assertTrue((root / "millie/20261105-030000-123/rollback.inventory.json").exists())
            self.assertTrue((newest / "rollback/state.sqlite").exists())
            self.assertTrue((root / "millie/20261106-030000-123/rollback/state.sqlite").exists())
            (root / "millie/20261105-030000-123/rollback").mkdir()
            (root / "millie/20261105-030000-123/rollback/state.sqlite").write_bytes(b"changed")
            held = archive.prune(root, "millie", apply=True, probe=lambda path: (_ for _ in ()).throw(RuntimeError("live owner")))
            self.assertIn("20261105-030000-123", held["held"])
            self.assertTrue((root / "millie/20261105-030000-123/rollback").exists())

    def test_rollback_retention_honors_dangling_stop_markers(self):
        import sqlite3
        for stop_name in ('STOP-ALL', 'STOP-disk-retention'):
            with self.subTest(stop_name=stop_name), tempfile.TemporaryDirectory() as directory:
                home = Path(directory).resolve()
                root = home / 'archive'
                for name in ('20261105-030000-123', '20261106-030000-123'):
                    payload = root / 'millie' / name / 'rollback'
                    payload.mkdir(parents=True)
                    with sqlite3.connect(payload / 'state.sqlite') as db:
                        db.execute('CREATE TABLE saved(value TEXT)')
                    (payload.parent / 'rollback.inventory.json').write_text(
                        json.dumps({'sha256': archive.inventory(payload)}))
                control = home / 'Codex_Workroom/task_evidence/otis-control'
                control.mkdir(parents=True)
                (control / stop_name).symlink_to(home / 'absent-target')
                with patch.object(archive.Path, 'home', return_value=home):
                    result = archive.prune(root, 'millie', apply=True, probe=lambda path: None)
                self.assertEqual(result['removed'], [])
                self.assertIn('20261105-030000-123', result['held'])
                self.assertTrue((root / 'millie/20261105-030000-123/rollback/state.sqlite').exists())

    def test_archive_retention_fails_closed_for_unhealthy_and_locked_payloads(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / "archive"
            older = root / "millie/20261105-030000-123/rollback"
            newer = root / "millie/20261106-030000-123/rollback"
            for payload in (older, newer):
                payload.mkdir(parents=True)
                with sqlite3.connect(payload / "state.sqlite") as db:
                    db.execute("CREATE TABLE saved(value TEXT)")
                (payload.parent / "rollback.inventory.json").write_text(json.dumps({"sha256": archive.inventory(payload)}))
            preview = archive.prune(root, "millie", probe=lambda path: None)
            self.assertEqual(preview["eligible"], [older.parent.name])
            self.assertTrue(older.exists())
            with archive.retention_lock(root):
                with self.assertRaises(BlockingIOError):
                    archive.prune(root, "millie", apply=True, probe=lambda path: None)
            (newer / "state.sqlite").write_bytes(b"corrupt but accurately inventoried")
            (newer.parent / "rollback.inventory.json").write_text(json.dumps({"sha256": archive.inventory(newer)}))
            result = archive.prune(root, "millie", apply=True, probe=lambda path: None)
            self.assertEqual(result["kept"], older.parent.name)
            self.assertEqual(result["removed"], [])
            self.assertTrue(older.exists())
            alias = root.with_name("alias")
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                archive.prune(alias, "millie", apply=True, probe=lambda path: None)

    def test_verified_newer_current_rollback_replaces_archive_payload(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "archive"
            old = root / "millie/20261105-030000-123/rollback"
            current = base / "backups/20261106030000000-0123456789ab"
            for payload in (old, current):
                payload.mkdir(parents=True)
                with sqlite3.connect(payload / "state.sqlite") as db:
                    db.execute("CREATE TABLE saved(value TEXT)")
                    db.execute("INSERT INTO saved VALUES ('retained fixture')")
            (old.parent / "rollback.inventory.json").write_text(json.dumps({"sha256": archive.inventory(old)}))
            marker = current.parent / "latest-rollback.json"
            marker.write_text(json.dumps({"marker":"t3-fork-backend-deployment-v1","directory":str(current)}))
            result = archive.prune(root, "millie", apply=True, probe=lambda path: None, retained_marker=marker)
            self.assertEqual(result["kept"], current.name)
            self.assertFalse(old.exists())
            self.assertTrue((current / "state.sqlite").exists())
            with sqlite3.connect((current / 'state.sqlite').as_uri() + '?mode=ro&immutable=1', uri=True) as db:
                self.assertEqual(db.execute('SELECT value FROM saved').fetchall(), [('retained fixture',)])
            self.assertTrue((old.parent / "rollback.inventory.json").exists())
            old.mkdir()
            with sqlite3.connect(old / 'state.sqlite') as db:
                db.execute('CREATE TABLE saved(value TEXT)')
            (old.parent / 'rollback.inventory.json').write_text(json.dumps({'sha256': archive.inventory(old)}))
            (current / 'state.sqlite').write_bytes(b'corrupt current backup')
            refused = archive.prune(root, 'millie', apply=True, probe=lambda path: None, retained_marker=marker)
            self.assertIn('current_rollback_unverified', refused['held'])
            self.assertEqual(refused['removed'], [])
            self.assertTrue(old.exists())
            (current / 'state.sqlite').unlink()
            with sqlite3.connect(current / 'state.sqlite') as db:
                db.execute('CREATE TABLE saved(value TEXT)')
            for name in ('20261107030000000-0123456789ab', '20261108030000000-0123456789ab'):
                payload = root / 'millie' / name / 'rollback'
                payload.mkdir(parents=True)
                with sqlite3.connect(payload / 'state.sqlite') as db:
                    db.execute('CREATE TABLE saved(value TEXT)')
                (payload.parent / 'rollback.inventory.json').write_text(json.dumps({'sha256': archive.inventory(payload)}))
            newest = archive.prune(root, 'millie', apply=True, probe=lambda path: None, retained_marker=marker)
            self.assertEqual(newest['kept'], '20261108030000000-0123456789ab')
            self.assertFalse((root / 'millie/20261107030000000-0123456789ab/rollback').exists())
            self.assertTrue((current / 'state.sqlite').exists())

    def test_unsigned_archive_app_cannot_replace_the_only_recovery_copy(self):
        import sqlite3
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / 'archive'
            for name in ('20261105-030000-123', '20261106-030000-123'):
                receipt = root / 'elora' / name
                data = receipt / 'rollback/t3-home/userdata'
                data.mkdir(parents=True)
                with sqlite3.connect(data / 'state.sqlite') as db:
                    db.execute('CREATE TABLE saved(value TEXT)')
                (receipt / 'previous-app').mkdir()
                for slot in ('rollback', 'previous-app'):
                    (receipt / (slot + '.inventory.json')).write_text(json.dumps({'sha256': archive.inventory(receipt / slot)}))
            with patch.object(archive.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
                result = archive.prune(root, 'elora', apply=True, probe=lambda path: None)
            self.assertEqual(result['removed'], [])
            self.assertTrue((root / 'elora/20261105-030000-123/rollback').exists())


if __name__ == "__main__":
    unittest.main()
