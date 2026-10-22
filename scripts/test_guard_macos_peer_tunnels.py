from pathlib import Path
import contextlib
import io
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

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

    def test_restart_preserves_outage_start(self):
        state = {}
        for now in (0, 60, 120, 180):
            guard.advance(state, guard.T3_LABEL, False, now)
        self.assertEqual(state[guard.T3_LABEL]['since'], 0)

    def test_only_verified_parentless_proxy_is_a_candidate(self):
        proxy = Path('/Users/example/.ssh/millie-lan-proxy.py')
        orphan = '123 1 Thu Oct 22 10:00:00 2026 /usr/bin/python3 ' + str(proxy)
        live = orphan.replace('123 1 ', '124 987 ')
        unrelated = orphan.replace(str(proxy), '/tmp/unrelated.py')
        self.assertEqual(guard.candidate_orphans([orphan, live, unrelated], proxy), [(123, orphan)])

    def test_reused_pid_is_not_killed(self):
        proxy = Path.home() / '.ssh/millie-lan-proxy.py'
        row = '123 1 Thu Oct 22 10:00:00 2026 /usr/bin/python3 ' + str(proxy)
        with patch.object(guard.subprocess, 'check_output', return_value=row), patch.object(guard.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=row.replace('10:00:00', '10:01:00'))), patch.object(guard.os, 'kill') as kill:
            guard.clean_orphans()
            kill.assert_not_called()


class ProbeTests(unittest.TestCase):
    def probe(self, payload, elapsed=0.2):
        with patch.object(guard.urllib.request, 'urlopen', return_value=io.StringIO(payload)) as request, patch.object(guard.time, 'monotonic', side_effect=[0, elapsed]):
            result = guard.probe_t3()
            self.assertEqual(request.call_args.args[0], 'http://127.0.0.1:13773/.well-known/t3/environment')
            return result

    def test_correct_environment_is_healthy(self):
        self.assertTrue(self.probe(json.dumps({'environmentId': 'bffdc8c2-0b56-43ce-ac20-9ff998298220'})))

    def test_html_fallback_is_not_a_healthy_backend(self):
        self.assertFalse(self.probe('<html>T3</html>'))

    def test_other_computer_is_not_healthy(self):
        self.assertFalse(self.probe('{"environmentId":"elora"}'))

    def test_slow_response_is_not_healthy(self):
        self.assertFalse(self.probe(json.dumps({'environmentId': 'bffdc8c2-0b56-43ce-ac20-9ff998298220'}), 5.1))

    def test_timeout_is_a_failure(self):
        with patch.object(guard.urllib.request, 'urlopen', side_effect=TimeoutError):
            self.assertFalse(guard.probe_t3())


class RecoveryCycleTests(unittest.TestCase):
    def test_persisted_failures_restart_only_t3_then_recover(self):
        with tempfile.TemporaryDirectory() as root, patch.object(guard, 'ROOT', Path(root)), patch.object(guard, 'LOG'), patch.object(guard, 'probe_t3', side_effect=[False, False, True]), patch.object(guard, 'clean_orphans'), patch.object(guard.time, 'time', side_effect=[0, 60, 120]), patch.object(guard.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as restart, contextlib.redirect_stdout(io.StringIO()):
            guard.cycle()
            restart.assert_not_called()
            guard.cycle()
            restart.assert_called_once()
            self.assertEqual(restart.call_args.args[0][-1], 'gui/%s/%s' % (guard.os.getuid(), guard.T3_LABEL))
            guard.cycle()
            state = json.loads((Path(root) / 'state.json').read_text())
            self.assertTrue(state['observations'][guard.T3_LABEL])
            self.assertEqual(state[guard.T3_LABEL]['failures'], 0)
            self.assertIsNone(state[guard.T3_LABEL]['since'])


if __name__ == '__main__':
    unittest.main()
