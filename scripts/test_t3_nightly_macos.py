"""Small local fixtures. No production state, network, models or schedules."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch, call
import signal
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

    def test_current_ready_provider_is_idle_but_unknown_or_running_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "userdata").mkdir()
            sqlite3.connect(root / "userdata/state.sqlite").close()
            with sqlite3.connect(root / "userdata/statev2.sqlite") as db:
                for suffix in host.SETTLED:
                    db.execute("CREATE TABLE orchestration_v2_projection_" + suffix + "(status TEXT,payload_json TEXT)")
                db.execute("INSERT INTO orchestration_v2_projection_provider_sessions VALUES('ready','{}')")
                db.commit()
                host.current_idle(root)
                for status in ("running", "future"):
                    db.execute("UPDATE orchestration_v2_projection_provider_sessions SET status=?", (status,))
                    db.commit()
                    with self.assertRaises(host.guard.Hold):
                        host.current_idle(root)

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


if __name__ == "__main__":
    unittest.main()
