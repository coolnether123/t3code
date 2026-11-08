#!/usr/bin/env python3
"""Run one prepared guarded release under launchd, then continue its owning thread."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
import uuid

ACTIVE = {'preparing', 'queued', 'starting', 'running', 'waiting'}


class ReleaseHeld(RuntimeError):
    pass


def write_once(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def check_stops(root, automation):
    if any(os.path.lexists(root / name) for name in ('STOP-ALL', 'STOP-' + automation)):
        raise ReleaseHeld('STOP control holds release and continuation')


def human_messages(detail):
    return [m['id'] for m in detail.get('messages', [])
            if m.get('role') == 'user' and m.get('createdBy') == 'user']


def continuation(config, detail):
    thread = detail['thread']
    runs = detail.get('runs', [])
    source = next((r for r in runs if r['id'] == config['sourceRunId']), None)
    if (thread['id'] != config['threadId'] or thread['projectId'] != config['projectId']
            or human_messages(detail) != config['userMessageIds']
            or any(thread.get(k) for k in ('archivedAt', 'deletedAt', 'snoozedUntil'))
            or thread.get('settledOverride') == 'settled'
            or source is None or source['status'] not in {'completed', 'interrupted', 'cancelled'}
            or max(runs, key=lambda r: r.get('ordinal', 0))['id'] != source['id']
            or any(r.get('status') in ACTIVE for r in runs)
            or any(r.get('status') == 'pending' for r in detail.get('runtimeRequests', []))
            or any(t.get('status') in {'pending', 'running'} for t in detail.get('providerTurns', []))
            or any(t.get('pendingBackgroundTasks') for t in detail.get('providerThreads', []))
            or any(t.get('type') in {'run_interrupt_request', 'thread_stop_request'}
                   and t.get('runId') in {None, source['id']} for t in detail.get('turnItems', []))):
        raise ReleaseHeld('Owning thread changed, is stopped, or already has work; do not duplicate')
    ident = str(uuid.uuid5(uuid.NAMESPACE_URL, 't3-release:' + config['releaseId']))
    # Completed/cancelled release owners cannot use the interrupted-only manual-resume command.
    return dict(type='message.dispatch', commandId=ident, threadId=thread['id'],
                messageId=ident + '-message', text=config['continuationText'], attachments=[],
                createdBy='system', creationSource='server', dispatchMode=dict(type='start_immediately'))


def runtime(config, root):
    sys.path.insert(0, config['runtimeAdapterDirectory'])
    from t3_runtime import T3Runtime
    return T3Runtime(ledger_path=root / 'continuation-ledger.json')


def launch(config_path):
    config = json.loads(config_path.read_text())
    root = config_path.parent
    if (root / 'release-intent.json').exists() or (root / 'launch.json').exists():
        raise ReleaseHeld('Existing launch or release intent must be reconciled, never replayed')
    check_stops(Path(config['stopDirectory']), config['automationId'])
    detail = runtime(config, root)._detail(config['threadId'])
    active = [r for r in detail.get('runs', []) if r.get('status') in ACTIVE]
    if len(active) != 1 or active[0]['id'] != config['sourceRunId']:
        raise ReleaseHeld('Release no longer belongs to the captured active run')
    if human_messages(detail) != config['userMessageIds']:
        raise ReleaseHeld('New human instruction before launch')
    label = 'com.t3code.release.' + hashlib.sha256(config['releaseId'].encode()).hexdigest()[:16]
    plist = root / 'supervisor.plist'
    with plist.open('xb') as stream:
        plistlib.dump(dict(Label=label, RunAtLoad=True, KeepAlive=False,
                           ProgramArguments=[sys.executable, str(Path(__file__).resolve()), 'execute', str(config_path)],
                           StandardOutPath=str(root / 'supervisor.log'), StandardErrorPath=str(root / 'supervisor.log'),
                           WorkingDirectory=str(root), ProcessType='Background',
                           EnvironmentVariables=dict(PATH=os.environ.get('PATH', '/usr/bin:/bin'))), stream)
    write_once(root / 'launch.json', dict(label=label, manifestSha256=hashlib.sha256(config_path.read_bytes()).hexdigest(),
                                          at=time.time(), sourceRunId=config['sourceRunId']))
    subprocess.run(['launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(plist)], check=True)
    print(json.dumps(dict(launched=True, label=label, result=str(root / 'release-result.json'))))


def execute(config_path):
    if os.getppid() != 1:
        raise ReleaseHeld('Release worker must be launchd-owned outside the T3 process tree')
    root = config_path.parent
    config = json.loads(config_path.read_text())
    launch_receipt = json.loads((root / 'launch.json').read_text())
    if hashlib.sha256(config_path.read_bytes()).hexdigest() != launch_receipt['manifestSha256']:
        raise ReleaseHeld('Prepared release manifest changed')
    with (root / 'supervisor.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_stops(Path(config['stopDirectory']), config['automationId'])
        rt = runtime(config, root)
        if not (root / 'release-result.json').exists():
            write_once(root / 'release-intent.json', dict(at=time.time(), pid=os.getpid(), parentPid=os.getppid(),
                                                        command=config['releaseCommand']))
            env = {k: v for k, v in os.environ.items()
                   if not k.startswith(('T3CODE_', 'T3_NIGHTLY_', 'VITE_'))
                   and k not in {'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'}}
            env.update(config.get('releaseEnvironment', {}))
            with (root / 'release.log').open('xb') as log:
                run = subprocess.run(config['releaseCommand'], cwd=config['sourceRoot'], env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            with (root / 'verify.log').open('xb') as log:
                verified = subprocess.run(config['verifyCommand'], env=env, stdin=subprocess.DEVNULL,
                                          stdout=log, stderr=subprocess.STDOUT)
            readback = json.loads(Path(config['verifyReceipt']).read_text()) if verified.returncode == 0 else {}
            healthy = verified.returncode == 0 and readback.get('liveHealthy') is True
            target_installed = readback.get('installedCommit') == config['targetInstalledCommit']
            write_once(root / 'release-result.json', dict(at=time.time(), releaseExit=run.returncode,
                                                         liveHealthy=healthy, targetInstalled=target_installed,
                                                         readback=readback))
        result = json.loads((root / 'release-result.json').read_text())
        if not result['liveHealthy']:
            raise ReleaseHeld('No verified healthy target or rollback; read existing result')
        if (root / 'continuation.json').exists():
            return
        check_stops(Path(config['stopDirectory']), config['automationId'])
        try:
            command = continuation(config, rt._detail(config['threadId']))
            receipt = rt._dispatch_once(command, 'release-continuation-' + config['releaseId'])
            write_once(root / 'continuation.json', dict(dispatched=True, receipt=receipt))
        except ReleaseHeld as error:
            if not (root / 'continuation-held.json').exists():
                write_once(root / 'continuation-held.json', dict(dispatched=False, reason=str(error)))
            raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['launch', 'execute'])
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    try:
        (launch if args.action == 'launch' else execute)(args.manifest.resolve())
    except Exception as error:
        # API transport errors are already redacted; never log credentials or a raw subprocess environment.
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
