#!/usr/bin/python3
"""Probe Elora's two Millie forwards and record bounded recovery attempts."""
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
DECK_LABEL = 'com.christine.codexdeck.tunnel'
GUARD_LABEL = 'com.t3tools.macos-peer-health'
ROOT = Path.home() / '.local/share/t3-peer-health'
DROP_MESSAGE = "T3's link to Millie dropped; I'm reconnecting it."
SSH = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', 'millie-codex']
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


def provider_alert(state, providers):
    codex = [v for v in providers if v.get('driver') == 'codex' and v.get('enabled')]
    errors = sorted(v['instanceId'] for v in codex if v.get('status') == 'error')
    if errors:
        entry = state.setdefault('providerError', {'requestKey': 't3-providers-' + str(uuid.uuid4()), 'notified': False})
        return None if entry['notified'] else entry
    if codex and all(v.get('status') == 'ready' for v in codex):
        state.pop('providerError', None)
    return None


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
        with urllib.request.urlopen('http://127.0.0.1:13773/api/v1/environment', timeout=5) as response:
            descriptor = json.load(response)
        return time.monotonic() - started <= 5 and descriptor.get('environmentId') == 'bffdc8c2-0b56-43ce-ac20-9ff998298220'
    except (OSError, ValueError):
        return False


def probe_reverse_deck():
    started = time.monotonic()
    try:
        reply = subprocess.run(SSH + ['/usr/bin/curl --silent --max-time 4 --output /dev/null --write-out "%{http_code}" http://127.0.0.1:8787/'], capture_output=True, text=True, timeout=5)
        return reply.returncode == 0 and reply.stdout.strip() in ('200', '302', '401', '403') and time.monotonic() - started <= 5
    except (OSError, subprocess.TimeoutExpired):
        return False


def deck_note(text, key):
    token = ''
    try:
        token = (Path.home() / '.codexdeck/agent_token').read_text().strip()
    except OSError:
        try:
            token = json.loads((Path.home() / '.codexdeck/token').read_text()).get('agent', '')
        except (OSError, ValueError):
            pass
    if not token:
        return False
    request = urllib.request.Request('http://127.0.0.1:8787/api/v1/otis_room/ask', data=json.dumps({'kind': 'note', 'text': text, 'request_key': key}).encode(), headers={'X-Deck-Token': token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.load(response)
        return bool(result.get('ok') and result.get('id'))
    except (OSError, ValueError):
        return False


def read_providers():
    try:
        reply = subprocess.run(SSH + ['/Users/millie/.local/bin/t3 agent request --base-dir /Users/millie/.t3'], input='{"kind":"providers"}\n', capture_output=True, text=True, timeout=15)
        if reply.returncode == 0:
            return json.loads(reply.stdout).get('providers')
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


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
        observations = {T3_LABEL: probe_t3(), DECK_LABEL: probe_reverse_deck()}
        for label, healthy in observations.items():
            if advance(state, label, healthy, now):
                # Persist the attempted recovery before issuing a non-idempotent restart.
                save_state(state)
                reply = subprocess.run(['/bin/launchctl', 'kickstart', '-k', 'gui/%s/%s' % (os.getuid(), label)], capture_output=True, timeout=8)
                LOG.warning('tunnel restart label=%s exit=%s', label, reply.returncode)
        link = state[T3_LABEL]
        if link['since'] is not None and now - link['since'] >= 300 and not link['notified']:
            if deck_note(DROP_MESSAGE, link['requestKey']):
                link['notified'] = True
                LOG.warning('five minute link outage note delivered')
        clean_orphans()
        providers = read_providers()
        if providers is not None:
            notice = provider_alert(state, providers)
            if notice:
                save_state(state)
                if deck_note("Millie's T3 Codex providers report an error. Otis needs to inspect them.", notice['requestKey']):
                    notice['notified'] = True
                    LOG.warning('provider error note delivered to Otis room and retained event stream')
        state['observedAt'] = now
        state['observations'] = observations
        save_state(state)
        print(json.dumps({'observedAt': now, 't3ForwardHealthy': observations[T3_LABEL], 'deckReverseHealthy': observations[DECK_LABEL], 'providersRead': providers is not None}))


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
