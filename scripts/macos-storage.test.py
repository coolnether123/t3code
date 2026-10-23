import importlib.util
from pathlib import Path
from contextlib import closing
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).with_name('macos-storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageTests(unittest.TestCase):
    def test_startup_reserves_separate_database_copy_only_when_needed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state.sqlite').write_bytes(b'x' * 8192)
            (root / 'state.sqlite-wal').write_bytes(b'x' * 4096)
            self.assertEqual(storage.startup_allocation(root), 12288 + storage.METADATA_RESERVE)
            with patch.object(storage.os, 'statvfs', return_value=SimpleNamespace(f_bavail=storage.FLOOR + storage.METADATA_RESERVE + 8192, f_frsize=1), create=True):
                with self.assertRaisesRegex(RuntimeError, 'projected free below 20 GiB'):
                    storage.require_capacity(root, storage.startup_allocation(root))
            (root / 'statev2.sqlite').write_bytes(b'current')
            self.assertEqual(storage.startup_allocation(root), storage.METADATA_RESERVE)

    def test_projected_floor(self):
        with patch.object(storage.os, 'statvfs', return_value=SimpleNamespace(f_bavail=storage.FLOOR + 4096, f_frsize=1), create=True):
            with self.assertRaisesRegex(RuntimeError, 'projected free below 20 GiB'):
                storage.require_capacity('.', 8192)
            storage.require_capacity('.', 4096)

    @unittest.skipUnless(sys.platform == 'darwin', 'APFS integration requires Darwin')
    def test_quiescent_clone_remains_a_point_in_time_rollback(self):
        with tempfile.TemporaryDirectory(prefix='t3-synthetic-apfs-') as directory:
            original, backup = Path(directory) / 'state.sqlite', Path(directory) / 'rollback.sqlite'
            db = sqlite3.connect(original)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE messages(id TEXT PRIMARY KEY,value TEXT)')
            db.execute("INSERT INTO messages VALUES('message-1','synthetic original')")
            db.commit()
            db.close()
            storage.checkpoint(original)
            storage.clone(original, backup)
            storage.verify(backup)
            db = sqlite3.connect(original)
            db.execute("UPDATE messages SET value='synthetic newer'")
            db.commit()
            db.close()
            with closing(sqlite3.connect(backup.as_uri() + '?mode=ro&immutable=1', uri=True)) as old, old:
                self.assertEqual(old.execute('SELECT value FROM messages').fetchone()[0], 'synthetic original')
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                storage.clone(original, backup)


if __name__ == '__main__':
    unittest.main()
