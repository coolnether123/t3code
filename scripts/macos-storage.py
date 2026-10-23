"""Forced APFS clones and prospective capacity admission for T3 maintenance."""
import argparse
import ctypes
import os
import json
import re
import shutil
from pathlib import Path
from contextlib import closing
import sqlite3

FLOOR = 20 * 1024**3
METADATA_RESERVE = 1024**2


def require_capacity(path, allocation=0):
    volume = os.statvfs(path)
    available = volume.f_bavail * volume.f_frsize
    if allocation < 0 or available - allocation < FLOOR:
        raise RuntimeError(
            f"T3 space guard: refusing step, projected free below 20 GiB; "
            f"available_bytes={available}, allocation_bytes={allocation}"
        )


def startup_allocation(directory):
    directory = Path(directory)
    current = directory / 'statev2.sqlite'
    if current.is_symlink():
        raise RuntimeError('Current SQLite database is symlinked')
    if current.exists():
        if not current.is_file():
            raise RuntimeError('Current SQLite database is not a file')
        return METADATA_RESERVE
    legacy = directory / 'state.sqlite'
    if legacy.is_symlink() or not legacy.is_file():
        raise RuntimeError('Legacy SQLite database missing or symlinked')
    wal = directory / 'state.sqlite-wal'
    if wal.is_symlink():
        raise RuntimeError('Legacy SQLite WAL is symlinked')
    # initializeV2Database makes a physical SQLite backup before migration.
    return legacy.stat().st_size + (wal.stat().st_size if wal.exists() else 0) + METADATA_RESERVE


def clone(source, destination):
    source, destination = Path(source), Path(destination)
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("APFS clone destination already exists")
    require_capacity(destination.parent, METADATA_RESERVE)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
    elif source.is_dir():
        destination.mkdir(mode=0o700)
        for child in source.iterdir():
            clone(child, destination / child.name)
    elif source.is_file():
        lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        fn = lib.clonefile
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        fn.restype = ctypes.c_int
        if fn(os.fsencode(source), os.fsencode(destination), 0) != 0:
            raise OSError(ctypes.get_errno(), "APFS clone failed, no copy fallback")
    else:
        raise RuntimeError("Unsupported APFS clone source")


def checkpoint(database):
    database = Path(database)
    wal = Path(str(database) + '-wal')
    require_capacity(database.parent, (wal.stat().st_size if wal.exists() else 0) * 2 + METADATA_RESERVE)
    with closing(sqlite3.connect(database)) as db, db:
        result = db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        if result not in ((0, 0, 0), (0, -1, -1)):
            raise RuntimeError("Quiescent SQLite checkpoint incomplete")
    if wal.exists() and wal.stat().st_size:
        raise RuntimeError("SQLite WAL still contains writes")


def verify(database):
    with closing(sqlite3.connect(Path(database).as_uri() + '?mode=ro&immutable=1', uri=True)) as db, db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError("APFS database rollback integrity failed")


def retire_previous(current, previous_app, app):
    current, previous_app, app = Path(current), Path(previous_app), Path(app)
    root = current.parent.resolve()
    if current.is_symlink() or current.resolve().parent != root:
        raise RuntimeError("Rollback ownership boundary mismatch")
    verify(current / 't3-home/userdata/state.sqlite')
    marker = root / 'latest-apfs-rollback.json'
    obsolete = None
    if marker.exists():
        saved = json.loads(marker.read_text())
        old = Path(saved['directory'])
        old_app = Path(saved['previous_app'])
        if saved.get('marker') != 't3-desktop-apfs-v1' or old.is_symlink() or old.resolve().parent != root:
            raise RuntimeError("Previous rollback ownership mismatch")
        if not re.fullmatch(r'\d{8}-\d{6}-\d+', old.name):
            raise RuntimeError("Previous rollback name mismatch")
        if old_app.is_symlink() or old_app.parent != app.parent or old_app.name != '.' + app.stem + '.previous.' + old.name + '.app':
            raise RuntimeError("Previous application boundary mismatch")
        if not (old / 't3-home/userdata/state.sqlite').is_file() or not old_app.is_dir():
            raise RuntimeError("Previous rollback incomplete")
        if old != current:
            obsolete = old, old_app
    require_capacity(root, METADATA_RESERVE)
    temp = root / ('latest-apfs-rollback.' + str(os.getpid()) + '.pending')
    with temp.open('x') as handle:
        json.dump({'marker': 't3-desktop-apfs-v1', 'directory': str(current), 'previous_app': str(previous_app)}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    temp.chmod(0o600)
    temp.replace(marker)
    if obsolete:
        shutil.rmtree(obsolete[0])
        shutil.rmtree(obsolete[1])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['capacity', 'startup', 'clone', 'checkpoint', 'verify', 'retire'])
    parser.add_argument('path')
    parser.add_argument('destination', nargs='?')
    parser.add_argument('--allocation', type=int, default=0)
    parser.add_argument('--app')
    args = parser.parse_args()
    if args.operation == 'capacity':
        require_capacity(args.path, args.allocation)
    elif args.operation == 'startup':
        require_capacity(args.path, startup_allocation(args.path))
    elif args.operation == 'clone':
        if not args.destination:
            parser.error('clone requires destination')
        clone(args.path, args.destination)
    elif args.operation == 'checkpoint':
        checkpoint(args.path)
    elif args.operation == 'verify':
        verify(args.path)
    else:
        if not args.destination or not args.app:
            parser.error('retire requires previous application and --app')
        retire_previous(args.path, args.destination, args.app)
