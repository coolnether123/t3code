import importlib.util
import json
import pathlib
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location('title_backfill', pathlib.Path(__file__).with_name('backfill-thread-title-dates.py'))
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)


class BackfillTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript('CREATE TABLE projection_threads(thread_id,title,created_at,deleted_at);'
                              'CREATE TABLE orchestration_events(sequence,event_type,actor_kind,command_id,payload_json);')

    def add(self, name, title, actor='server', kind='thread.meta-updated', created='2026-10-05T02:30:00Z'):
        self.db.execute('INSERT INTO projection_threads VALUES(?,?,?,NULL)', (name, title, created))
        self.event(name, title, actor, kind)

    def event(self, name, title, actor='server', kind='thread.meta-updated'):
        seq = self.db.execute('SELECT count(*) FROM orchestration_events').fetchone()[0] + 1
        self.db.execute('INSERT INTO orchestration_events VALUES(?,?,?,?,?)',
                        (seq, kind, actor, 'synthetic', json.dumps({'threadId': name, 'title': title})))

    def test_uses_creation_date_and_retains_title_content(self):
        self.add('synthetic-auto', 'Audit')
        plan, _ = backfill.plan_titles(self.db)
        self.assertEqual(plan[0]['after'], '10/4 Audit')
        self.assertEqual(plan[0]['before'], 'Audit')

    def test_skips_detectable_manual_and_unknown_imported_titles(self):
        self.add('synthetic-manual', 'My title', actor='client')
        self.add('synthetic-import', 'Imported', kind='thread.created')
        plan, skipped = backfill.plan_titles(self.db)
        self.assertEqual(plan, [])
        self.assertEqual(skipped['manual_or_unknown'], 2)

    def test_ignores_non_title_metadata_after_an_automatic_title(self):
        self.add('synthetic-auto', 'Audit')
        self.db.execute('INSERT INTO orchestration_events VALUES(2,?,?,?,?)',
                        ('thread.meta-updated', 'client', 'synthetic', json.dumps({'threadId': 'synthetic-auto', 'branch': 'work'})))
        self.assertEqual(len(backfill.plan_titles(self.db)[0]), 1)

    def test_manual_rename_after_automatic_title_is_preserved(self):
        self.add('synthetic-auto', 'My title')
        self.event('synthetic-auto', 'My title', actor='client')
        self.assertEqual(backfill.plan_titles(self.db)[0], [])

    def test_second_pass_never_stacks_dates(self):
        self.add('synthetic-auto', 'Audit')
        item = backfill.plan_titles(self.db)[0][0]
        self.db.execute('UPDATE projection_threads SET title=?', (item['after'],))
        self.event('synthetic-auto', item['after'], actor='client')
        self.assertEqual(backfill.plan_titles(self.db)[0], [])

    def test_existing_padded_dates_and_deleted_chats_are_untouched(self):
        self.add('synthetic-prefix', '10/04 Audit')
        self.add('synthetic-deleted', 'Audit')
        self.db.execute('UPDATE projection_threads SET deleted_at=? WHERE thread_id=?', ('synthetic', 'synthetic-deleted'))
        self.assertEqual(backfill.plan_titles(self.db)[0], [])

    def test_missing_timezone_refuses_instead_of_guessing(self):
        self.add('synthetic-invalid', 'Audit', created='2026-10-04T23:30:00')
        with self.assertRaises(ValueError):
            backfill.plan_titles(self.db)


if __name__ == '__main__':
    unittest.main()
