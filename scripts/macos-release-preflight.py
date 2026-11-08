#!/usr/bin/env python3
"""Boot a packaged desktop on copied real state before stopping the live app."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.request


def desktop_environment(environ):
    env = dict(environ)
    for key in list(env):
        if key.startswith(('T3CODE_BOOTSTRAP_', 'VITE_')) or key in (
            'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'T3CODE_DESKTOP_BOOTSTRAP_FD', 'T3CODE_PARENT_PID',
        ):
            del env[key]
    return env


RESERVE_BYTES = 20 * 1024**3
COPY_HEADROOM = 64 * 1024**2


def snapshot_allocation(database):
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as live:
        page_size = live.execute('PRAGMA page_size').fetchone()[0]
        pages = live.execute('PRAGMA page_count').fetchone()[0]
        free_pages = live.execute('PRAGMA freelist_count').fetchone()[0]
    return 2 * (pages - free_pages) * page_size + COPY_HEADROOM


def snapshot(home, destination):
    userdata = destination / 'userdata'
    userdata.mkdir(parents=True, mode=0o700)
    source = home / 'userdata'
    name = 'statev2.sqlite' if (source / 'statev2.sqlite').exists() else 'state.sqlite'
    if shutil.disk_usage(destination.parent).free - snapshot_allocation(source / name) < RESERVE_BYTES:
        raise RuntimeError('copied-state preflight would cross the 20 GiB reserve')
    target = userdata / name
    with sqlite3.connect((source / name).as_uri() + '?mode=ro', uri=True) as live:
        reserve_lost = False

        def check_reserve():
            nonlocal reserve_lost
            reserve_lost = shutil.disk_usage(destination.parent).free < RESERVE_BYTES + COPY_HEADROOM
            return int(reserve_lost)

        live.set_progress_handler(check_reserve, 1)
        try:
            live.execute('VACUUM INTO ?', (str(target),))
        except sqlite3.OperationalError:
            if reserve_lost:
                raise RuntimeError('copied-state preflight would cross the 20 GiB reserve') from None
            raise
    with sqlite3.connect(target) as copied:
        if copied.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('copied-state snapshot integrity check failed')
        tables = {row[0] for row in copied.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        # Keep the full database and migration history, but never replay copied work.
        threads = 'orchestration_v2_projection_threads'
        if threads in tables:
            copied.execute(f"UPDATE {threads} SET deleted_at='2000-01-01T00:00:00Z'")
        for table in ('scheduled_tasks', 'orchestration_v2_effect_outbox',
                      'orchestration_v2_thread_launch_workflows', 'provider_session_runtime',
                      'auth_sessions', 'auth_pairing_links', 'peer_environment_links'):
            if table in tables:
                copied.execute('DELETE FROM ' + table)
    for name in ('environment-id', 'settings.json', 'client-settings.json'):
        if (source / name).is_file():
            shutil.copy2(source / name, userdata / name)
    # Neither the live connection catalog nor browser sessions or secrets are copied.
    return target.stat().st_size


def processes():
    rows = {}
    for line in subprocess.check_output(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,command='], text=True).splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows[int(parts[0])] = (int(parts[1]), parts[2])
    return rows


def preflight(app, home, output, wait_seconds=90, backend=None, node=None):
    home, output = home.resolve(), output.resolve()
    app = app.resolve() if app else None
    if output.exists() or output == home or home in output.parents or output in home.parents:
        raise ValueError('preflight requires a fresh directory outside the live home')
    output.mkdir(mode=0o700, parents=True)
    isolated = output / 'home'
    size = snapshot(home, isolated)
    executable = (app / 'Contents/MacOS' / plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleExecutable']) if app else node.resolve()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    env = desktop_environment(os.environ)
    log = output / 'desktop.log'
    isolated_env = dict(HOME=str(isolated), CODEX_HOME=str(isolated / 'no-credentials'),
                           T3CODE_HOME=str(isolated), T3CODE_PORT=str(port),
                           T3CODE_BACKGROUND_LAUNCH='1', T3CODE_DISABLE_AUTO_UPDATE='1',
                           T3CODE_NO_BROWSER='true', T3CODE_TAILSCALE_SERVE='false')
    if app:
        args = ['open', '-g', '-n', '-a', str(app)]
        for key, value in isolated_env.items():
            args += ['--env', key + '=' + value]
        args += ['--stdout', str(log), '--stderr', str(log)]
    else:
        args = [str(executable), str(backend.resolve()), 'serve', '--mode', 'web', '--base-dir', str(isolated), '--host', '127.0.0.1', '--port', str(port), '--no-browser']
        env.update(isolated_env)
    owned = {}
    identity = (app / 'Contents/Resources/app.asar') if app else backend.resolve()
    receipt = dict(healthy=False, port=port, copiedDatabaseBytes=size,
                   candidateSha256=hashlib.sha256(identity.read_bytes()).hexdigest(),
                   recovery='disabled in copied database', sourceHome=str(home))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        child = None
        if app:
            if any(command == str(executable) for _, command in processes().values()):
                raise RuntimeError('preflight candidate is already running')
            subprocess.run(args, env=env, check=True, timeout=15)
        else:
            with log.open('xb') as stream:
                child = subprocess.Popen(args, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            rows = processes()
            if child.pid in rows:
                owned[child.pid] = rows[child.pid][1]
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            rows = processes()
            for pid, (parent, command) in rows.items():
                if (app and command == str(executable)) or parent in owned:
                    owned[pid] = command
            try:
                listener = subprocess.check_output(['/usr/sbin/lsof', '-nP', '-iTCP:' + str(port), '-sTCP:LISTEN', '-Fp'], text=True, stderr=subprocess.DEVNULL)
                pids = {int(line[1:]) for line in listener.splitlines() if line.startswith('p')}
                if len(pids) != 1 or not pids.issubset(owned):
                    raise ValueError('preflight listener is not owned by the candidate')
                for route in ('/api/health', '/api/auth/session', '/.well-known/t3/environment'):
                    with opener.open('http://127.0.0.1:' + str(port) + route, timeout=3) as response:
                        if response.status != 200:
                            raise ValueError('preflight health endpoint failed')
                        if route.endswith('/environment'):
                            descriptor = json.loads(response.read(65536))
                            if descriptor.get('environmentId') != (isolated / 'userdata/environment-id').read_text().strip():
                                raise ValueError('preflight environment differs')
                receipt.update(healthy=True, health=200, listenerPid=next(iter(pids)))
                break
            except (OSError, ValueError, subprocess.SubprocessError):
                time.sleep(1)
    finally:
        rows = processes()
        for pid, command in owned.items():
            if pid in rows and rows[pid][1] == command:
                try:
                    os.kill(pid, 15)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 3
        while any(pid in processes() for pid in owned) and time.monotonic() < deadline:
            time.sleep(0.1)
        rows = processes()
        for pid, command in reversed(list(owned.items())):
            if pid in rows and rows[pid][1] == command:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
        if child is not None:
            child.wait(timeout=5)
        receipt['ownedPids'] = list(owned)
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
    if not receipt['healthy']:
        raise RuntimeError('candidate failed copied-state desktop preflight; live app unchanged')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--app', type=Path)
    target.add_argument('--backend', type=Path)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--home', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.backend and not args.node:
        parser.error('--backend requires --node')
    preflight(args.app, args.home, args.output, backend=args.backend, node=args.node)
