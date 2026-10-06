"""One guarded local T3 upgrade. Closed gates defer to the next Central night."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import sys
import urllib.request
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/Chicago')
LABEL = 'com.christine.t3-stopped-chat-upgrade'


def save(path, value):
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    temporary = path.with_suffix('.pending')
    with temporary.open('w') as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for part in iter(lambda: handle.read(1024*1024), b''):
            value.update(part)
    return value.hexdigest()


def counts(home):
    path = home/'.t3/userdata/state.sqlite'
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as conn:
        conn.execute('BEGIN')
        queries = {
            'approvals': "SELECT COUNT(*) FROM projection_pending_approvals WHERE status='pending'",
            'inputs': 'SELECT COUNT(*) FROM projection_threads WHERE pending_user_input_count>0',
            'runtime': "SELECT COUNT(*) FROM provider_session_runtime WHERE status IN ('starting','running')",
            'unknown_runtime': "SELECT COUNT(*) FROM provider_session_runtime WHERE status IS NULL OR status NOT IN ('starting','running','stopped','error')",
            'unknown_sessions': "SELECT COUNT(*) FROM projection_thread_sessions WHERE status IS NULL OR status NOT IN ('idle','starting','running','ready','interrupted','stopped','error')",
            'unknown_approvals': "SELECT COUNT(*) FROM projection_pending_approvals WHERE status IS NULL OR status NOT IN ('pending','resolved','stale')",
            'invalid_inputs': 'SELECT COUNT(*) FROM projection_threads WHERE pending_user_input_count IS NULL OR pending_user_input_count<0',
            'unaccounted_turns': "SELECT COUNT(*) FROM projection_thread_sessions s LEFT JOIN provider_session_runtime r ON r.thread_id=s.thread_id WHERE (s.status IN ('starting','running') OR s.active_turn_id IS NOT NULL) AND (r.thread_id IS NULL OR r.status NOT IN ('stopped','error'))",
        }
        return {key: conn.execute(query).fetchone()[0] for key, query in queries.items()}


def health(home):
    expected = (home/'.t3/userdata/environment-id').read_text().strip()
    with urllib.request.urlopen('http://127.0.0.1:3773/.well-known/t3/environment', timeout=5) as response:
        value = json.load(response)
    if value.get('environmentId') != expected:
        raise RuntimeError('environment_identity_changed')
    with urllib.request.urlopen('http://127.0.0.1:3773/', timeout=5) as response:
        if response.status != 200:
            raise RuntimeError('root_health_failed')
    return value


def eligible(now, idle, state):
    return (now.tzinfo is not None and 2 <= now.astimezone(ZONE).hour < 4
            and idle is not None and idle > 5400 and bool(state)
            and all(type(value) is int and value == 0 for value in state.values()))


def gate(home):
    now = datetime.datetime.now(ZONE)
    raw = subprocess.check_output(['/usr/sbin/ioreg', '-c', 'IOHIDSystem'], text=True)
    match = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', raw)
    idle = int(match[1])/1e9 if match else None
    state = counts(home)
    health(home)
    return dict(at=now.isoformat(), idle_seconds=idle, counts=state,
                eligible=eligible(now, idle, state))


def validated_config(home):
    folder = home/'.codexdeck/t3-upgrade'
    config = json.loads((folder/'config.json').read_text())
    assert config['home'] == str(home) and home.name in ('christinesmith', 'millie')
    assert re.fullmatch('[0-9a-f]{40}', config['source_commit'])
    for name, expected in config['hashes'].items():
        path = Path(name)
        assert path.is_absolute() and not path.is_symlink() and digest(path) == expected, 'prepared_build_changed'
    return folder, config


def deployed(home, config):
    if home.name == 'christinesmith':
        current = Path('/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar')
        return current.exists() and digest(current) == config['app_asar_sha256']
    value = health(home)
    pid = value.get('runtime', {}).get('pid')
    if type(pid) is not int or pid <= 0:
        return False
    command = shlex.split(subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'command='], text=True))
    expected = str(home/'.local/lib/t3-fork'/config['source_commit']/'dist/bin.mjs')
    return expected in command and digest(Path(expected)) == config['server_entry_sha256']


def deploy(home, folder, config):
    env = dict(os.environ, PATH=str(home/'.local/bin')+':'+os.environ.get('PATH', ''),
               T3CODE_DEPLOY_CODE_ONLY='1', T3CODE_PRESTOP_GUARD=str(Path(__file__).resolve()))
    stamp = datetime.datetime.now(ZONE).strftime('%Y%m%d-%H%M%S')
    if home.name == 'christinesmith':
        env['T3CODE_PREPARED_APP'] = config['prepared_app']
        command = ['/bin/bash', config['desktop_deployer'], '--source-root', config['source_root'],
                   '--expected-branch', 'fix/stopped-chat-replies', '--expected-commit', config['source_commit'],
                   '--skip-build', '--backup-root', str(folder/'rollback'),
                   '--artifact-dir', str(folder/('activation-'+stamp))]
    else:
        value = health(home)
        pid = value.get('runtime', {}).get('pid')
        assert type(pid) is int and pid > 0, 'live_pid_unavailable'
        old = shlex.split(subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'command='], text=True))
        entry = next((item for item in old if item.endswith('/dist/bin.mjs')), None)
        assert entry and '--base-dir' in old and old[old.index('--base-dir')+1] == str(home/'.t3'), 'live_process_changed'
        command = [config['node'], config['backend_deployer'], '--execute', '--candidate', config['candidate'],
                   '--commit', config['source_commit'], '--expected-old-pid', str(pid), '--old-entry', entry,
                   '--backup-root', str(folder/'rollback'), '--smoke-home', str(folder/('synthetic-smoke-'+stamp))]
    # The deployers call this job's gate-only path again immediately before stopping.
    assert gate(home)['eligible'], 'gate_changed_before_deploy'
    with (folder/('deployment-'+stamp+'.log')).open('w') as log:
        os.chmod(log.name, 0o600)
        subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)


def run(home):
    now = datetime.datetime.now(ZONE)
    if not 2 <= now.hour < 4:
        return
    folder, config = validated_config(home)
    receipt_path = folder/'receipt.json'
    previous = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    if previous.get('phase') == 'complete' or previous.get('attempt_day') == now.date().isoformat():
        return
    receipt = dict(at=now.isoformat(), attempt_day=now.date().isoformat(), phase='waiting',
                   source_commit=config['source_commit'])
    try:
        receipt['gate'] = gate(home)
        if not receipt['gate']['eligible']:
            receipt['reason'] = 'idle_or_pending_gate_closed'
            return
        if not deployed(home, config):
            receipt['phase'] = 'deploy_intent'
            save(receipt_path, receipt)
            deploy(home, folder, config)
        assert deployed(home, config), 'running_build_not_verified'
        live = health(home)
        receipt['runtime'] = live.get('runtime')
        marker = home/'.codexdeck/jev_t3_enabled'
        if not marker.exists():
            with marker.open('x') as handle:
                os.chmod(marker, 0o600)
                handle.write(config['source_commit']+'\n')
        receipt.update(phase='complete', health=200, delivery_enabled=True,
                       completed_at=datetime.datetime.now(ZONE).isoformat())
    except Exception as error:
        receipt.update(phase='waiting', reason=str(error) if re.fullmatch('[a-z_]+', str(error)) else type(error).__name__)
    finally:
        save(receipt_path, receipt)
    if receipt['phase'] == 'complete':
        # A complete marker also makes later login loads no-ops. Keep the receipt.
        subprocess.run(['/bin/launchctl', 'bootout', 'gui/'+str(os.getuid())+'/'+LABEL], capture_output=True)


if __name__ == '__main__':
    home = Path.home()
    if '--gate-only' in sys.argv:
        try:
            validated_config(home)
            observed = gate(home)
            print(json.dumps(observed))
            sys.exit(0 if observed['eligible'] else 1)
        except Exception:
            sys.exit(1)
    else:
        lock = home/'.codexdeck/t3-upgrade/upgrade.lock'
        with lock.open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            run(home)
