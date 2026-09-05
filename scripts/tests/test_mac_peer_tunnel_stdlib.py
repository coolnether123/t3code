#!/usr/bin/env python3
"""Focused stdlib tests for setup-macos-peer-tunnel.py."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import pathlib
import plistlib
import stat
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "setup-macos-peer-tunnel.py"
SPEC = importlib.util.spec_from_file_location("setup_macos_peer_tunnel", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class MacPeerTunnelStdlibTests(unittest.TestCase):
    def make_config(self, root: pathlib.Path, **overrides):
        values = {
            "ssh_alias": "wanda-codex",
            "local_port": 13773,
            "remote_port": 3773,
            "label": "com.example.mac-peer-test",
            "plist_path": root / "LaunchAgents" / "peer.plist",
            "log_path": root / "Logs" / "peer.log",
        }
        values.update(overrides)
        return MODULE.make_config(**values)

    def test_default_forward_is_loopback_only_and_contains_no_key_material(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            plist = MODULE.build_plist(config)

        self.assertEqual(
            plist["ProgramArguments"],
            [
                "/usr/bin/ssh",
                "-N",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ConnectTimeout=15",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "-L",
                "13773:127.0.0.1:3773",
                "wanda-codex",
            ],
        )
        serialized = MODULE.plist_bytes(config).decode("utf-8")
        self.assertNotIn("IdentityFile", serialized)
        self.assertNotIn("authorized_keys", serialized)
        self.assertNotIn("PRIVATE", serialized)
        self.assertTrue(plist["KeepAlive"])
        self.assertTrue(plist["RunAtLoad"])
        self.assertEqual(plist["ThrottleInterval"], 30)

    def test_validation_rejects_shell_and_out_of_range_values(self):
        for alias in ("", "ssh -o BatchMode=no", "../peer", "-peer"):
            with self.subTest(alias=alias):
                with self.assertRaises(MODULE.SetupError):
                    MODULE.validate_alias(alias)

        for value in (0, -1, 65536, "not-a-port"):
            with self.subTest(value=value):
                with self.assertRaises(MODULE.SetupError):
                    MODULE.validate_port(value, "local port")

    def test_atomic_write_uses_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            MODULE.write_plist(config)

            self.assertEqual(stat.S_IMODE(config.plist_path.stat().st_mode), 0o600)
            payload = plistlib.loads(config.plist_path.read_bytes())
            self.assertEqual(payload, MODULE.build_plist(config))

    def test_different_existing_plist_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            config = self.make_config(root)
            config.plist_path.parent.mkdir(parents=True)
            original = b"<?xml version=\"1.0\"?><plist><dict><key>Owner</key><string>other</string></dict></plist>"
            config.plist_path.write_bytes(original)

            with self.assertRaises(MODULE.SetupError):
                MODULE.check_conflicts(config, loaded=False)
            self.assertEqual(config.plist_path.read_bytes(), original)

    def test_listener_conflict_is_rejected_before_a_new_plist_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            with mock.patch.object(MODULE, "listener_pids", return_value=[4321]):
                with self.assertRaises(MODULE.SetupError):
                    MODULE.check_conflicts(config, loaded=False)
            self.assertFalse(config.plist_path.exists())

    def test_dry_run_prints_plan_without_writing_or_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            plist_path = root / "LaunchAgents" / "peer.plist"
            log_path = root / "Logs" / "peer.log"
            output = io.StringIO()
            with (
                mock.patch.object(MODULE, "launchd_loaded", return_value=False),
                mock.patch.object(MODULE, "listener_pids", return_value=[]),
                mock.patch.object(MODULE.sys, "platform", "darwin"),
                contextlib.redirect_stdout(output),
            ):
                result = MODULE.main(
                    [
                        "--dry-run",
                        "--ssh-alias",
                        "wanda-codex",
                        "--local-port",
                        "13773",
                        "--remote-port",
                        "3773",
                        "--plist-path",
                        str(plist_path),
                        "--log-path",
                        str(log_path),
                    ]
                )

            self.assertEqual(result, 0)
            self.assertIn("127.0.0.1:13773 -> peer 127.0.0.1:3773", output.getvalue())
            self.assertFalse(plist_path.exists())
            self.assertFalse(log_path.exists())


if __name__ == "__main__":
    unittest.main()
