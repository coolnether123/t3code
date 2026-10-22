#!/usr/bin/python3
"""Recover Elora's T3 link to Millie after two missed minute probes."""
import argparse
import fcntl
import getpass
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

T3_LABEL = 'com.t3tools.macos-peer-tunnel'
GUARD_LABEL = 'com.t3tools.macos-peer-health'
ROOT = Path.home() / '.local/share/t3-peer-health'
LOG = logging.getLogger('t3-peer-health')


def advance(state, label, healthy, now):
    item = state.setdefault(label, {'failures': 0, 'since': None, 'notified': False})
    if healthy:
        item.update(failures=0, since=None, notified=False)
        item.pop('requestKey', None)
        return False
    item['failures'] += 1
    if item['since'] is None or now < item['since']:
        item['since'] = now
        item['requestKey'] = 't3-link-' + str(uuid.uuid4())
    if item['failures'] >= 2:
        item['failures'] = 0
        return True
    return False


def candidate_orphans(rows, proxy):
    result = []
    for row in rows:
        fields = row.strip().split(None, 7)
        if len(fields) != 8 or fields[1] != '1':
            continue
        try:
            command = shlex.split(fields[7])
            if len(command) >= 2 and command[1] == str(proxy) and Path(command[0]).name.lower() in ('python', 'python3', 'python3.9', 'python3.11'):
                result.append((int(fields[0]), row.strip()))
        except (ValueError, IndexError):
            continue
    return result


def clean_orphans():
    proxy = Path.home() / '.ssh/millie-lan-proxy.py'
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,lstart=,command='], text=True).splitlines()
    for pid, identity in candidate_orphans(rows, proxy):
        check = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,lstart=,command='], capture_output=True, text=True, timeout=3)
        if check.returncode == 0 and check.stdout.strip() == identity:
            try:
                os.kill(pid, signal.SIGTERM)
                LOG.warning('terminated verified orphan proxy pid=%s', pid)
            except ProcessLookupError:
                pass


def probe_t3():
    started = time.monotonic()
    try:
        with urllib.request.urlopen('http://127.0.0.1:13773/.well-known/t3/environment', timeout=5) as response:
            descriptor = json.load(response)
        return time.monotonic() - started <= 5 and descriptor.get('environmentId') == 'bffdc8c2-0b56-43ce-ac20-9ff998298220'
    except (OSError, ValueError):
        return False


def save_state(state):
    descriptor, name = tempfile.mkstemp(prefix='state-', dir=ROOT)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            json.dump(state, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, ROOT / 'state.json')
    finally:
        Path(name).unlink(missing_ok=True)


def cycle():
    ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    with (ROOT / 'cycle.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            state = json.loads((ROOT / 'state.json').read_text())
        except FileNotFoundError:
            state = {}
        now = time.time()
        observations = {T3_LABEL: probe_t3()}
        for label, healthy in observations.items():
            if advance(state, label, healthy, now):
                # Persist the attempted recovery before issuing a non-idempotent restart.
                save_state(state)
                reply = subprocess.run(['/bin/launchctl', 'kickstart', '-k', 'gui/%s/%s' % (os.getuid(), label)], capture_output=True, timeout=8)
                LOG.warning('tunnel restart label=%s exit=%s', label, reply.returncode)
        clean_orphans()
        state['observedAt'] = now
        state['observations'] = observations
        save_state(state)
        print(json.dumps({'observedAt': now, 't3ForwardHealthy': observations[T3_LABEL]}))


def install():
    ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    target = ROOT / 'guard.py'
    shutil.copyfile(__file__, target)
    target.chmod(0o700)
    plist = Path.home() / ('Library/LaunchAgents/' + GUARD_LABEL + '.plist')
    payload = {'Label': GUARD_LABEL, 'ProgramArguments': ['/usr/bin/python3', '-B', str(target), '--once'], 'RunAtLoad': True, 'StartInterval': 60, 'ProcessType': 'Background', 'StandardOutPath': str(ROOT / 'launcher.log'), 'StandardErrorPath': str(ROOT / 'launcher-error.log')}
    if plist.exists():
        old = plistlib.loads(plist.read_bytes())
        if old.get('ProgramArguments') != payload['ProgramArguments']:
            raise RuntimeError('Existing health guard has a different owner')
        raise RuntimeError('Health guard already installed; reconcile before replacing')
    plist.write_bytes(plistlib.dumps(payload))
    plist.chmod(0o600)
    subprocess.run(['/bin/launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(plist)], check=True, timeout=10)
    print(json.dumps({'installed': str(target), 'launchAgent': str(plist), 'intervalSeconds': 60}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin' or getpass.getuser() != 'christinesmith':
        raise RuntimeError('This guard belongs to Elora')
    ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    handler = RotatingFileHandler(ROOT / 'recovery.log', maxBytes=1024 * 1024, backupCount=3)
    formatter = logging.Formatter('%(asctime)sZ %(message)s')
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    if args.install:
        install()
    else:
        cycle()


if __name__ == '__main__':
    main()
