"""Synthetic tests only. No real database, socket, process, or deployment."""
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
from contextlib import closing
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("guard", pathlib.Path(__file__).with_name("macos-activation-guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def test_current_schema_missing_other_projections_holds_even_with_terminal_runs(self):
        with closing(sqlite3.connect(self.root / "statev2.sqlite")) as db, db:
            db.execute("CREATE TABLE orchestration_v2_projection_runs(status TEXT)")
            db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('completed')")
        with self.assertRaises(guard.Hold):
            guard.current_database_snapshot(str(self.db))

    def test_native_failure_stderr_is_private_and_timeout_remains_held(self):
        sock = self.root / "native.sock"
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(sock))
            manifest = dict(self.m, native_socket=str(sock), node="/synthetic/node", ws_require_from="/synthetic/package.json")
            for result in (subprocess.CompletedProcess([], 1, "", "native-rpc-timeout:thread/list\n"),
                           subprocess.TimeoutExpired([], 610, stderr=b"native-proof-timeout\n")):
                with self.subTest(result=type(result).__name__):
                    action = {"side_effect": result} if isinstance(result, Exception) else {"return_value": result}
                    before = set(self.root.glob("native-proof-*.stderr.log"))
                    with patch.object(guard.subprocess, "run", **action) as child:
                        with self.assertRaisesRegex(guard.Hold, "native read-only proof unavailable"):
                            guard.native_snapshot(manifest, [])
                    self.assertGreaterEqual(child.call_args.kwargs["timeout"], 610)
                    logs = set(self.root.glob("native-proof-*.stderr.log")) - before
                    self.assertEqual(len(logs), 1)
                    log = logs.pop()
                    self.assertEqual(log.stat().st_mode & 0o777, 0o600)
                    self.assertIn("native-", log.read_text())
                    self.assertFalse(pathlib.Path(manifest["baseline_file"]).exists())

    def test_wildcard_requires_explicit_existing_network_setting_and_exact_listener(self):
        setting = self.root / "desktop-settings.json"
        setting.write_text('{"serverExposureMode":"network-accessible"}')
        setting.chmod(0o600)
        manifest = {"listener_pid": 123, "listener_addresses": ["*:3773"],
                    "environment_file": str(self.root / "environment-id"),
                    "network_config": {"path": str(setting), "sha256": guard.file_digest(setting)}}
        guard.check_listener_identity(manifest, "p123\nn*:3773", "3773")
        for changed in ({"listener_pid": 124}, {"listener_addresses": ["127.0.0.1:3773"]},
                        {"network_config": None}, {"environment_file": str(self.root / "other/environment-id")}):
            with self.subTest(changed=changed), self.assertRaises(guard.Hold):
                guard.check_listener_identity(dict(manifest, **changed), "p123\nn*:3773", "3773")
        setting.write_text('{"serverExposureMode":"local-only"}')
        manifest["network_config"]["sha256"] = guard.file_digest(setting)
        with self.assertRaises(guard.Hold):
            guard.check_listener_identity(manifest, "p123\nn*:3773", "3773")
        guard.check_listener_identity({"listener_pid": 123}, "p123\nn127.0.0.1:3773", "3773")
        with self.assertRaises(guard.Hold):
            guard.check_listener_identity({"listener_pid": 123}, "p123\nn*:3773", "3773")

    def test_separate_current_database_blocks_idle_legacy_database(self):
        current = self.root / "statev2.sqlite"
        with closing(sqlite3.connect(current)) as db, db:
            db.execute("CREATE TABLE orchestration_v2_projection_runs(status TEXT)")
            db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('running')")
        with self.assertRaisesRegex(guard.Busy, "current orchestration"):
            guard.database_snapshot(str(self.db))
        with closing(sqlite3.connect(current)) as db, db:
            db.execute("UPDATE orchestration_v2_projection_runs SET status='completed'")
        with self.assertRaisesRegex(guard.Hold, "schema unavailable"):
            guard.database_snapshot(str(self.db))
        with closing(sqlite3.connect(current)) as db, db:
            db.execute("DROP TABLE orchestration_v2_projection_runs")
        with self.assertRaisesRegex(guard.Hold, "schema unavailable"):
            guard.database_snapshot(str(self.db))

    def test_new_orchestrator_runs_block_legacy_idle_detection(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("CREATE TABLE orchestration_v2_projection_runs(status TEXT)")
            db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('running')")
        with self.assertRaisesRegex(guard.Busy, "current orchestration"):
            guard.database_snapshot(str(self.db))
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE orchestration_v2_projection_runs SET status='completed'")
        self.assertEqual(len(guard.database_snapshot(str(self.db))["bindings"]), 1)
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE orchestration_v2_projection_runs SET status='future_status'")
        with self.assertRaisesRegex(guard.Busy, "current orchestration"):
            guard.database_snapshot(str(self.db))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name).resolve()
        self.db = self.root / "state.sqlite"
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript("""
                CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,adapter_key TEXT,status TEXT,resume_cursor_json TEXT);
                CREATE TABLE projection_thread_sessions(thread_id TEXT,status TEXT,active_turn_id TEXT);
                CREATE TABLE projection_pending_approvals(request_id TEXT,thread_id TEXT,status TEXT);
                CREATE TABLE projection_threads(thread_id TEXT,pending_user_input_count INTEGER,latest_turn_id TEXT,deleted_at TEXT);
                CREATE TABLE projection_thread_messages(thread_id TEXT,role TEXT,is_streaming INTEGER,turn_id TEXT);
                CREATE TABLE projection_thread_activities(activity_id TEXT,thread_id TEXT,kind TEXT,payload_json TEXT);
                INSERT INTO provider_session_runtime VALUES('t3','codex','codex','running','{"threadId":"native"}');
                INSERT INTO projection_thread_sessions VALUES('t3','ready',NULL);
                INSERT INTO projection_pending_approvals VALUES('approval','t3','pending');
                INSERT INTO projection_threads VALUES('t3',1,'last',NULL);
                INSERT INTO projection_threads VALUES('t4',2,'last2',NULL);
                INSERT INTO projection_thread_activities VALUES('1','t3','user-input.requested','{}');
                INSERT INTO projection_thread_activities VALUES('2','t3','user-input.resolved','{}');
                INSERT INTO projection_thread_activities VALUES('3','t3','user-input.requested','{}');
                INSERT INTO projection_thread_activities VALUES('4','t4','user-input.requested','{}');
                INSERT INTO projection_thread_activities VALUES('5','t4','user-input.resolved','{}');
                INSERT INTO projection_thread_activities VALUES('6','t4','user-input.requested','{}');
            """)
        self.m = {"baseline_file": str(self.root / "baseline.json"), "database": str(self.db),
                  "_manifest_sha256": "fresh", "environment_id": "synthetic"}
        self.native = {"idle": True, "bindings_checked": 1, "fingerprint": "idle"}

    def tearDown(self):
        self.temp.cleanup()

    def sql(self, sql):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute(sql)

    def safe(self):
        return patch.multiple(guard, check_pins=lambda m: None, native_snapshot=lambda m, bindings: self.native)

    def test_idle_preserves_millie_pending_requests_and_gate_has_no_writes(self):
        with self.safe():
            state = guard.admit(self.m, capture=True)
            baseline = pathlib.Path(self.m["baseline_file"])
            before = baseline.stat()
            self.assertEqual(state["state"]["pending"]["approvals_count"], 1)
            self.assertEqual(state["state"]["pending"]["input_threads_count"], 2)
            self.assertEqual(state["state"]["pending"]["input_events_count"], 6)
            guard.admit(self.m)
            self.assertEqual(before.st_mtime_ns, baseline.stat().st_mtime_ns)
            with self.assertRaises(guard.Hold):
                guard.admit(self.m, capture=True)

    def test_active_elora_native_turn_cannot_capture(self):
        with patch.object(guard, "check_pins"), patch.object(guard, "native_snapshot", side_effect=guard.Busy("active native turn")):
            with self.assertRaises(guard.Busy):
                guard.admit(self.m, capture=True)
        self.assertFalse(pathlib.Path(self.m["baseline_file"]).exists())

    def test_pending_change_between_idle_capture_observations(self):
        observations = [self.native, self.native]
        def native(m, bindings):
            if len(observations) == 1:
                self.sql("UPDATE projection_pending_approvals SET status='resolved'")
            return observations.pop()
        with patch.object(guard, "check_pins"), patch.object(guard, "native_snapshot", side_effect=native):
            with self.assertRaises(guard.Hold):
                guard.admit(self.m, capture=True)
        self.assertFalse(pathlib.Path(self.m["baseline_file"]).exists())

    def test_pending_payload_change_after_capture_holds(self):
        with self.safe():
            guard.admit(self.m, capture=True)
            self.sql("UPDATE projection_thread_activities SET payload_json='changed' WHERE activity_id='4'")
            with self.assertRaises(guard.Hold):
                guard.admit(self.m)

    def test_process_change_and_shutdown_refuse_before_native_probe(self):
        for reason in ("exact process changed", "process shut down"):
            with patch.object(guard, "check_pins", side_effect=guard.Hold(reason)), patch.object(guard, "native_snapshot") as native:
                with self.assertRaises(guard.Hold):
                    guard.admit(self.m, capture=True)
                native.assert_not_called()

    def test_mapping_unknown_holds(self):
        self.sql("UPDATE provider_session_runtime SET resume_cursor_json='{}'")
        with self.assertRaises(guard.Hold):
            guard.database_snapshot(str(self.db))

    def test_projection_running_streaming_and_unknown_hold(self):
        for sql in (
            "UPDATE projection_thread_sessions SET active_turn_id='active'",
            "INSERT INTO projection_thread_messages VALUES('t3','assistant',1,'last')",
            "UPDATE provider_session_runtime SET status='unrecognized'",
        ):
            with self.subTest(sql=sql):
                with closing(sqlite3.connect(self.db)) as db, db:
                    db.execute("SAVEPOINT fixture")
                    db.execute(sql)
                    db.commit()
                with self.assertRaises(guard.Hold):
                    guard.database_snapshot(str(self.db))
                self.sql("UPDATE projection_thread_sessions SET active_turn_id=NULL")
                self.sql("DELETE FROM projection_thread_messages")
                self.sql("UPDATE provider_session_runtime SET status='running'")

    def test_ready_provider_is_not_itself_an_active_turn(self):
        state = guard.database_snapshot(str(self.db))
        self.assertEqual(state["bindings"], [{"thread_id": "t3", "native_id": "native"}])

    def test_finite_wait_expires_and_does_not_retry_identity_failure(self):
        now = [0]
        def pause(seconds):
            now[0] += seconds
        with patch.object(guard, "admit", side_effect=guard.Busy("active")) as admission:
            with self.assertRaisesRegex(guard.Hold, "expired"):
                guard.finite_wait(self.m, 20, clock=lambda: now[0], pause=pause)
            self.assertEqual(admission.call_count, 3)
        with patch.object(guard, "admit", side_effect=guard.Hold("process changed")) as admission:
            with self.assertRaisesRegex(guard.Hold, "process changed"):
                guard.finite_wait(self.m, 20, clock=lambda: 0, pause=pause)
            self.assertEqual(admission.call_count, 1)

    def test_finite_wait_returns_after_one_successful_capture(self):
        with patch.object(guard, "admit", side_effect=[guard.Busy("active"), {"ok": True}]) as admission:
            self.assertEqual(guard.finite_wait(self.m, 20, pause=lambda seconds: None), {"ok": True})
            self.assertEqual(admission.call_count, 2)


class CurrentOrphanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name).resolve()
        self.path = self.root / 'state.sqlite'
        self.db = sqlite3.connect(self.root / 'statev2.sqlite')
        for name in ('runs', 'run_attempts', 'provider_turns', 'subagents', 'provider_threads',
                     'provider_sessions', 'runtime_requests', 'turn_items', 'nodes'):
            self.db.execute('CREATE TABLE orchestration_v2_projection_' + name +
                            '(status TEXT,payload_json TEXT,thread_id TEXT,run_id TEXT,provider_turn_id TEXT,runtime_request_id TEXT,provider_thread_id TEXT,provider_session_id TEXT)')
        self.db.executescript('''
            CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,archived_at TEXT,deleted_at TEXT);
            CREATE TABLE orchestration_v2_projection_provider_session_bindings(thread_id TEXT,provider_session_id TEXT);
            CREATE TABLE orchestration_v2_effect_outbox(status TEXT);
            INSERT INTO orchestration_v2_projection_threads VALUES ('t3','archived',NULL);
        ''')
        self.insert('runs', 'interrupted', {}, run_id='run')
        self.insert('provider_turns', 'interrupted', {}, provider_turn_id='turn')
        self.insert('provider_sessions', 'ready', {'id': 'session'})
        self.insert('runtime_requests', 'pending', {'id': 'request', 'nodeId': 'node', 'providerTurnId': 'turn',
                    'kind': 'command', 'responseCapability': {'type': 'live', 'providerSessionId': 'session'}}, runtime_request_id='request')
        self.insert('turn_items', 'waiting', {'id': 'item', 'nodeId': 'node', 'runId': 'run',
                    'providerTurnId': 'turn', 'requestId': 'request', 'type': 'approval_request'})
        self.insert('nodes', 'waiting', {'id': 'node'})
        self.insert('provider_threads', 'idle', {'driver': 'codex', 'nativeThreadRef': {
                    'driver': 'codex', 'strength': 'strong', 'nativeId': 'native'}, 'pendingBackgroundTasks': []})
        self.pins = [{'thread_id': 't3', 'request_id': 'request'}]
        self.db.commit()

    def insert(self, name, status, payload, **columns):
        payload = dict(payload, status=status)
        fields = dict(status=status, payload_json=json.dumps(payload), thread_id='t3', **columns)
        self.db.execute('INSERT INTO orchestration_v2_projection_' + name + '(' + ','.join(fields) + ') VALUES (' +
                        ','.join('?' for _ in fields) + ')', tuple(fields.values()))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def snapshot(self):
        return guard.current_database_snapshot(str(self.path), self.pins)

    def test_exact_archived_interrupted_unbound_orphan_preserves_rows(self):
        before = (self.root / 'statev2.sqlite').read_bytes()
        proof = self.snapshot()
        self.assertEqual(proof['orphan_count'], 1)
        self.assertEqual(proof['bindings'], [{'thread_id': 't3', 'native_id': 'native'}])
        self.assertEqual(before, (self.root / 'statev2.sqlite').read_bytes())
        with self.assertRaises(guard.Busy):
            guard.current_database_snapshot(str(self.path))

    def test_live_unknown_background_and_changed_orphan_hold(self):
        for mutation in (
            "UPDATE orchestration_v2_projection_threads SET archived_at=NULL",
            "UPDATE orchestration_v2_projection_runs SET status='running'",
            "UPDATE orchestration_v2_projection_provider_turns SET status='completed'",
            "INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES('t3','session')",
            "INSERT INTO orchestration_v2_effect_outbox VALUES('pending')",
            "UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.pendingBackgroundTasks',json('[{}]'))",
            "UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.nativeThreadRef',json('null'))",
            "UPDATE orchestration_v2_projection_subagents SET status='future'",
        ):
            with self.subTest(mutation=mutation):
                self.db.execute('SAVEPOINT test')
                self.db.execute(mutation)
                # Separate read-only connection sees committed state; restore with a snapshot.
                self.db.execute('RELEASE test')
                self.db.commit()
                if 'subagents SET' not in mutation:
                    with self.assertRaises(guard.Hold):
                        self.snapshot()
                self.tearDown()
                self.setUp()

    def test_other_waiting_requests_and_unknown_status_always_hold(self):
        for name in ('runtime_requests', 'turn_items', 'nodes', 'subagents', 'run_attempts', 'provider_sessions'):
            with self.subTest(name=name):
                self.insert(name, 'future', {'id': 'other'})
                self.db.commit()
                with self.assertRaises(guard.Busy):
                    self.snapshot()
                self.db.execute('DELETE FROM orchestration_v2_projection_' + name + " WHERE status='future'")
                self.db.commit()


if __name__ == "__main__":
    unittest.main()
