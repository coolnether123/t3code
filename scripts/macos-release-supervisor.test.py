import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('macos-release-supervisor.py'))
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class ContinuationTests(unittest.TestCase):
    def detail(self, status='completed'):
        return dict(thread=dict(id='thread', projectId='project'),
                    messages=[dict(id='human', role='user', createdBy='user')],
                    runs=[dict(id='source', ordinal=1, status=status)],
                    runtimeRequests=[], turnItems=[], providerThreads=[], providerTurns=[])

    def test_completed_switch_can_continue_without_manual_interrupted_run_contract(self):
        config = dict(threadId='thread', projectId='project', sourceRunId='source', userMessageIds=['human'],
                      releaseId='release', continuationText='Continue from checkpoint.')
        for status in ('completed', 'interrupted', 'cancelled'):
            with self.subTest(status=status):
                command = supervisor.continuation(config, self.detail(status))
                self.assertEqual(command['threadId'], 'thread')
                self.assertEqual(command['createdBy'], 'system')
                self.assertNotIn('manualContinuationOfRunId', command)
                self.assertEqual(command, supervisor.continuation(config, self.detail(status)))
        for change in ('new-human', 'stop', 'settled', 'pending', 'new-run', 'background'):
            detail = self.detail()
            if change == 'new-human':
                detail['messages'].append(dict(id='new', role='user', createdBy='user'))
            elif change == 'stop':
                detail['turnItems'].append(dict(type='run_interrupt_request', runId='source'))
            elif change == 'settled':
                detail['thread']['settledOverride'] = 'settled'
            elif change == 'pending':
                detail['runtimeRequests'].append(dict(status='pending'))
            elif change == 'new-run':
                detail['runs'].append(dict(id='other', ordinal=2, status='completed'))
            else:
                detail['providerThreads'].append(dict(pendingBackgroundTasks=True))
            with self.subTest(change=change), self.assertRaises(supervisor.ReleaseHeld):
                supervisor.continuation(config, detail)
        with self.assertRaises(supervisor.ReleaseHeld):
            supervisor.continuation(config, self.detail('running'))

    def test_existing_intent_is_never_reexecuted_and_stop_symlinks_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            supervisor.write_once(root / 'intent.json', dict(started=True))
            with self.assertRaises(FileExistsError):
                supervisor.write_once(root / 'intent.json', dict(started=True))
            (root / 'STOP-ALL').symlink_to(root / 'absent')
            with self.assertRaises(supervisor.ReleaseHeld):
                supervisor.check_stops(root, 'TREL6')


if __name__ == '__main__':
    unittest.main()
