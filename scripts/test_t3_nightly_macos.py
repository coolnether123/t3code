"""Small local fixtures. No production state, network, models or schedules."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


lock = module("nightly_lock", "t3-nightly-macos-lock.py")
archive = module("nightly_archive", "macos-rollback-archive.py")
host = module("nightly_host", "t3-nightly-macos-host.py")


class NightlyTests(unittest.TestCase):
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
