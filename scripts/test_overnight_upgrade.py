"""Disposable fixtures only. Never starts a server or accesses a real account."""
import datetime
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import overnight_upgrade as job


class UpgradeTests(unittest.TestCase):
    def test_window_chicago_dst_idle_and_each_protected_gate(self):
        state = dict(approvals=0, inputs=0, runtime=0, unknown=0)
        for date in ('2026-10-06T03:00:00-05:00', '2026-11-02T03:00:00-06:00'):
            now = datetime.datetime.fromisoformat(date)
            self.assertTrue(job.eligible(now, 5401, state))
            for idle in (None, 0, 5400):
                self.assertFalse(job.eligible(now, idle, state))
            for field in state:
                self.assertFalse(job.eligible(now, 5401, dict(state, **{field:1})))
            self.assertFalse(job.eligible(now, 5401, {}))
        self.assertFalse(job.eligible(datetime.datetime.fromisoformat('2026-10-06T04:00:00-05:00'), 9000, state))

    def test_pending_requests_count_even_on_stopped_provider_sessions(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);root=home/'.t3/userdata';root.mkdir(parents=True)
            with sqlite3.connect(root/'state.sqlite') as conn:
                conn.executescript('CREATE TABLE projection_pending_approvals(status TEXT); CREATE TABLE projection_threads(pending_user_input_count INTEGER); CREATE TABLE provider_session_runtime(thread_id TEXT,status TEXT); CREATE TABLE projection_thread_sessions(thread_id TEXT,status TEXT,active_turn_id TEXT);')
                conn.execute("INSERT INTO projection_pending_approvals VALUES ('pending')")
                conn.execute('INSERT INTO projection_threads VALUES (1)')
                conn.execute("INSERT INTO provider_session_runtime VALUES ('synthetic','stopped')")
            observed=job.counts(home)
            self.assertEqual((observed['approvals'], observed['inputs']),(1,1))

    def run_fixture(self, gate, existing=None, deploy_error=None, proof=True):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        home=Path(temp.name);folder=home/'.codexdeck/t3-upgrade';folder.mkdir(parents=True)
        receipt=folder/'receipt.json'
        if existing:receipt.write_text(json.dumps(existing))
        now=datetime.datetime.fromisoformat('2026-10-06T03:00:00-05:00')
        config=dict(source_commit='1'*40)
        with patch.object(job.datetime,'datetime',wraps=datetime.datetime) as clock, \
             patch.object(job,'validated_config',return_value=(folder,config)), \
             patch.object(job,'gate',return_value=dict(eligible=gate)), \
             patch.object(job,'deployed',side_effect=[False,proof]), \
             patch.object(job,'deploy',side_effect=deploy_error) as deploy, \
             patch.object(job,'health',return_value={'runtime':{'pid':999}}), \
             patch.object(job.subprocess,'run'):
            clock.now.return_value=now
            job.run(home)
        return json.loads(receipt.read_text()), deploy.call_count, home

    def test_closed_gate_never_calls_deployer_or_enables_delivery(self):
        receipt,calls,home=self.run_fixture(False)
        self.assertEqual(calls,0)
        self.assertEqual(receipt['phase'],'waiting')
        self.assertFalse((home/'.codexdeck/jev_t3_enabled').exists())

    def test_next_night_retry_but_not_repeated_checks_the_same_night(self):
        receipt,calls,_=self.run_fixture(False,dict(attempt_day='2026-10-05',phase='waiting'))
        self.assertEqual(receipt['attempt_day'],'2026-10-06')
        receipt,calls,_=self.run_fixture(True,dict(attempt_day='2026-10-06',phase='waiting'))
        self.assertEqual(calls,0)

    def test_complete_means_build_health_and_marker_verified(self):
        receipt,calls,home=self.run_fixture(True)
        self.assertEqual(calls,1)
        self.assertEqual((receipt['phase'],receipt['health']),('complete',200))
        self.assertEqual((home/'.codexdeck/jev_t3_enabled').read_text(),'1'*40+'\n')

    def test_wrong_build_cannot_be_claimed_complete_or_enable_delivery(self):
        receipt,_,home=self.run_fixture(True,proof=False)
        self.assertEqual(receipt['phase'],'waiting')
        self.assertFalse((home/'.codexdeck/jev_t3_enabled').exists())

    def test_failed_deploy_stays_pending_and_complete_is_idempotent(self):
        receipt,_,home=self.run_fixture(True,deploy_error=RuntimeError('synthetic_failure'))
        self.assertEqual(receipt['reason'],'synthetic_failure')
        self.assertFalse((home/'.codexdeck/jev_t3_enabled').exists())
        receipt,calls,_=self.run_fixture(True,dict(phase='complete'))
        self.assertEqual(calls,0)


if __name__=='__main__':unittest.main()
