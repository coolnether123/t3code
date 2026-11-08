import importlib.util
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('macos-release-preflight.py'))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def test_compact_snapshot_preserves_history_without_allocating_free_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source/userdata'
            source.mkdir(parents=True)
            database = source / 'statev2.sqlite'
            with sqlite3.connect(database) as db:
                db.executescript('CREATE TABLE history (id INTEGER PRIMARY KEY, payload BLOB); PRAGMA user_version=17;')
                db.executemany('INSERT INTO history VALUES (?, zeroblob(1048576))', [(n,) for n in range(80)])
                db.execute('DELETE FROM history WHERE id<>79')
            before = hashlib.sha256(database.read_bytes()).hexdigest()
            with patch.object(preflight.shutil, 'disk_usage') as usage:
                usage.return_value.free = 20 * 1024**3 + 70 * 1024**2
                size = preflight.snapshot(source.parent, root / 'copy')
            self.assertLess(size, 2 * 1024**2)
            with sqlite3.connect(root / 'copy/userdata/statev2.sqlite') as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 17)
                self.assertEqual(db.execute('SELECT id,length(payload) FROM history').fetchall(), [(79,1048576)])
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), before)
            with patch.object(preflight.shutil, 'disk_usage') as usage:
                usage.side_effect = [SimpleNamespace(free=20 * 1024**3 + 70 * 1024**2),
                                     SimpleNamespace(free=20 * 1024**3 + 63 * 1024**2)]
                with self.assertRaisesRegex(RuntimeError, '20 GiB reserve'):
                    preflight.snapshot(source.parent, root / 'reserve-lost')
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), before)

    def test_keeps_real_history_but_cannot_replay_copied_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source/userdata'
            source.mkdir(parents=True)
            database = source / 'statev2.sqlite'
            with sqlite3.connect(database) as db:
                db.executescript("""
                    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT, payload_json TEXT);
                    INSERT INTO orchestration_v2_projection_threads VALUES ('real-history', NULL, '{"title":"kept"}');
                    CREATE TABLE scheduled_tasks (id TEXT);
                    INSERT INTO scheduled_tasks VALUES ('must-not-run');
                    CREATE TABLE orchestration_v2_effect_outbox (id TEXT);
                    INSERT INTO orchestration_v2_effect_outbox VALUES ('must-not-replay');
                """)
            (source / 'environment-id').write_text('known-environment')
            (source / 'connection-catalog.json').write_text('do-not-copy')
            (source / 'secrets').mkdir()
            destination = root / 'isolated'
            with patch.object(preflight.shutil, 'disk_usage') as usage:
                usage.return_value.free = 30 * 1024**3
                preflight.snapshot(source.parent, destination)
            with sqlite3.connect(destination / 'userdata/statev2.sqlite') as db:
                row = db.execute('SELECT thread_id, deleted_at, payload_json FROM orchestration_v2_projection_threads').fetchone()
                self.assertEqual(row[0], 'real-history')
                self.assertIsNotNone(row[1])
                self.assertEqual(json.loads(row[2]), {'title': 'kept'})
                self.assertEqual(db.execute('SELECT count(*) FROM scheduled_tasks').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT count(*) FROM orchestration_v2_effect_outbox').fetchone()[0], 0)
            with sqlite3.connect(database) as db:
                self.assertIsNone(db.execute('SELECT deleted_at FROM orchestration_v2_projection_threads').fetchone()[0])
                self.assertEqual(db.execute('SELECT count(*) FROM scheduled_tasks').fetchone()[0], 1)
            self.assertFalse((destination / 'userdata/connection-catalog.json').exists())
            self.assertFalse((destination / 'userdata/secrets').exists())
            with patch.object(preflight.shutil, 'disk_usage') as usage:
                usage.return_value.free = 19 * 1024**3
                with self.assertRaisesRegex(RuntimeError, '20 GiB reserve'):
                    preflight.snapshot(source.parent, root / 'refused')
            self.assertFalse((root / 'refused/userdata/statev2.sqlite').exists())

    def test_desktop_drops_harness_bootstrap_and_node_mode(self):
        self.assertEqual(preflight.desktop_environment(dict(ELECTRON_RUN_AS_NODE='1', NODE_OPTIONS='bad', T3CODE_BOOTSTRAP_FD='3', T3CODE_PARENT_PID='10', PATH='kept')), {'PATH': 'kept'})


if __name__ == '__main__':
    unittest.main()
