from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import tempfile
import io
import contextlib
sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard_macos_peer_tunnels as guard

class TunnelHealthTests(unittest.TestCase):
    def test_two_consecutive_failures_restart(self):
        state = {}
        self.assertFalse(guard.advance(state, guard.T3_LABEL, False, 0))
        self.assertTrue(guard.advance(state, guard.T3_LABEL, False, 60))
    def test_success_resets_consecutive_failures(self):
        state = {}
        guard.advance(state, guard.T3_LABEL, False, 0)
        guard.advance(state, guard.T3_LABEL, True, 60)
        self.assertFalse(guard.advance(state, guard.T3_LABEL, False, 120))
    def test_restart_does_not_reset_outage_duration_or_retry_key(self):
        state = {}
        guard.advance(state, guard.T3_LABEL, False, 0)
        key = state[guard.T3_LABEL]['requestKey']
        for now in (60,120,180,240,300):
            guard.advance(state, guard.T3_LABEL, False, now)
        self.assertEqual(state[guard.T3_LABEL]['since'], 0)
        self.assertEqual(state[guard.T3_LABEL]['requestKey'], key)
    def test_recovery_is_silent_and_allows_next_incident(self):
        state = {}
        guard.advance(state, guard.T3_LABEL, False, 0)
        state[guard.T3_LABEL]['notified'] = True
        self.assertFalse(guard.advance(state, guard.T3_LABEL, True, 400))
        self.assertFalse(state[guard.T3_LABEL]['notified'])
        self.assertIsNone(state[guard.T3_LABEL]['since'])
    def test_provider_alert_once_until_all_codex_ready(self):
        state = {}
        error = [{'driver':'codex','enabled':True,'instanceId':'codex','status':'error'}]
        alert = guard.provider_alert(state,error)
        key = alert['requestKey']
        self.assertEqual(guard.provider_alert(state,error)['requestKey'],key)
        alert['notified'] = True
        self.assertIsNone(guard.provider_alert(state,error))
        guard.provider_alert(state,[{**error[0],'status':'ready'}])
        self.assertIsNotNone(guard.provider_alert(state,error))
    def test_claude_error_is_ignored(self):
        self.assertIsNone(guard.provider_alert({},[{'driver':'claudeAgent','enabled':True,'instanceId':'claude','status':'error'}]))
    def test_only_verified_parentless_proxy_is_a_candidate(self):
        proxy = Path('/Users/example/.ssh/millie-lan-proxy.py')
        prefix = '123 1 Thu Oct 22 10:00:00 2026 '
        orphan = prefix + '/usr/bin/python3 ' + str(proxy) + ' --port 22'
        live = orphan.replace('123 1 ', '124 987 ')
        unrelated = orphan.replace(str(proxy), '/tmp/unrelated.py')
        self.assertEqual(guard.candidate_orphans([orphan,live,unrelated],proxy),[(123,orphan)])

class ProbeDeadlineTests(unittest.TestCase):
    def test_a_slow_success_is_a_failure(self):
        reply = SimpleNamespace(returncode=0, stdout='200')
        with patch.object(guard.subprocess, 'run', return_value=reply), patch.object(guard.time, 'monotonic', side_effect=[0, 5.1]):
            self.assertFalse(guard.probe_reverse_deck())
    def test_a_fast_success_is_healthy(self):
        reply = SimpleNamespace(returncode=0, stdout='200')
        with patch.object(guard.subprocess, 'run', return_value=reply), patch.object(guard.time, 'monotonic', side_effect=[0, 0.2]):
            self.assertTrue(guard.probe_reverse_deck())
    def test_timeout_is_a_failure(self):
        with patch.object(guard.subprocess, 'run', side_effect=guard.subprocess.TimeoutExpired('ssh',5)):
            self.assertFalse(guard.probe_reverse_deck())

class RecoveryCycleTests(unittest.TestCase):
    def test_drop_note_once_after_five_minutes_and_no_recovery_note(self):
        with tempfile.TemporaryDirectory() as root, patch.object(guard, 'ROOT', Path(root)), patch.object(guard, 'LOG'), patch.object(guard, 'probe_t3', side_effect=[False,False,False,False,True]), patch.object(guard, 'probe_reverse_deck', return_value=True), patch.object(guard, 'clean_orphans'), patch.object(guard, 'read_providers', return_value=None), patch.object(guard.time, 'time', side_effect=[0,60,300,360,420]), patch.object(guard.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as restart, patch.object(guard, 'deck_note', return_value=True) as note, contextlib.redirect_stdout(io.StringIO()):
            for _ in range(5):
                guard.cycle()
            self.assertEqual(restart.call_count,2)
            note.assert_called_once()
            self.assertEqual(note.call_args.args[0],guard.DROP_MESSAGE)
    def test_failed_note_delivery_reuses_its_retry_key(self):
        with tempfile.TemporaryDirectory() as root, patch.object(guard, 'ROOT', Path(root)), patch.object(guard, 'LOG'), patch.object(guard, 'probe_t3', return_value=False), patch.object(guard, 'probe_reverse_deck', return_value=True), patch.object(guard, 'clean_orphans'), patch.object(guard, 'read_providers', return_value=None), patch.object(guard.time, 'time', side_effect=[0,300,360]), patch.object(guard.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), patch.object(guard, 'deck_note', return_value=False) as note, contextlib.redirect_stdout(io.StringIO()):
            for _ in range(3):
                guard.cycle()
            self.assertEqual(note.call_count,2)
            self.assertEqual(note.call_args_list[0].args[1],note.call_args_list[1].args[1])

if __name__ == '__main__':
    unittest.main()
