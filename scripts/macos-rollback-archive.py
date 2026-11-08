#!/usr/bin/env python3
"""Verified local retirement with one healthy archived rollback per host."""
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sqlite3
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
RECEIPT = re.compile(r'(?:\d{8}-\d{6}-\d+|\d{14,17}-[0-9a-f]{12})')

def inventory(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("archive source is not a real directory")
    entries = []
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            entries.append((relative, "link", os.readlink(path)))
        elif path.is_dir():
            entries.append((relative, "directory"))
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            entries.append((relative, "file", path.stat().st_size, digest.hexdigest()))
        else:
            raise RuntimeError("archive contains a special file")
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def _archive(source, host, receipt, slot="rollback", archive_root=None):
    if host not in ("elora", "millie") or not re.fullmatch(r"[0-9][0-9a-f-]+", receipt) or slot not in ("rollback", "previous-app"):
        raise RuntimeError("archive receipt identity differs")
    root = Path(archive_root) if archive_root is not None else Path.home() / ".local/share/t3-nightly/rollback-archive"
    if root == Path.home() or not root.is_absolute() or root.resolve() != root:
        raise RuntimeError("archive root differs")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError("archive ownership differs")
    target = root / host / receipt / slot
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(path.is_symlink() for path in (root, target.parent.parent, target.parent, target)):
        raise RuntimeError("archive ancestor is symlinked")
    source = Path(source)
    manifest = target.with_name(slot + ".inventory.json")
    if target.exists():
        saved = json.loads(manifest.read_text())
        if inventory(target) != saved["sha256"] or (source.exists() and inventory(source) != saved["sha256"]):
            raise RuntimeError("existing local archive differs; originals retained")
        return target
    expected = inventory(source)
    if source.stat().st_dev != root.stat().st_dev:
        raise RuntimeError("local archive must be on the same filesystem")
    with manifest.open("x") as handle:
        json.dump({"source": str(source), "sha256": expected}, handle)
    manifest.chmod(0o600)
    spec = importlib.util.spec_from_file_location("archive_storage", Path(__file__).with_name("macos-storage.py"))
    storage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(storage)
    storage.clone(source, target)
    if inventory(target) != expected or inventory(source) != expected:
        raise RuntimeError("cloned archive differs; recoverable originals retained")
    return target


def _directory(path):
    if path.resolve() != path or not path.is_dir() or path.is_symlink() or path.stat().st_uid != os.getuid():
        raise RuntimeError("rollback retention directory identity differs")


@contextlib.contextmanager
def retention_lock(root):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    _directory(root)
    descriptor = os.open(root / ".retention.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("rollback retention lock differs")
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def closed(path):
    result = subprocess.run(["/usr/sbin/lsof", "-nP", "-Fpn", "+D", str(path)], capture_output=True, text=True, timeout=60)
    if result.returncode != 1 or result.stdout.strip() or result.stderr.strip():
        raise RuntimeError("rollback retention open-file census held")
    result = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=20, check=True)
    for line in result.stdout.splitlines():
        pid, _, command = line.strip().partition(" ")
        if pid != str(os.getpid()) and str(path) in command:
            raise RuntimeError("rollback retention process reference held")


def _slots(path, host):
    slots = ("rollback", "previous-app") if host == "elora" else ("rollback",)
    for slot in slots:
        payload = path / slot
        _directory(payload)
        manifest = path / (slot + ".inventory.json")
        info = manifest.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise RuntimeError("rollback retention manifest differs")
        saved = json.loads(manifest.read_text())
        if not re.fullmatch(r"[0-9a-f]{64}", saved.get("sha256", "")) or inventory(payload) != saved["sha256"]:
            raise RuntimeError("rollback retention inventory differs")
        for parent, directories, files in os.walk(payload, followlinks=False):
            for name in directories + files:
                entry = Path(parent) / name
                entry_info = entry.lstat()
                if entry_info.st_uid != os.getuid() or entry_info.st_dev != payload.stat().st_dev:
                    raise RuntimeError("rollback retention foreign tree")
    return slots


def _healthy(path, host):
    slots = _slots(path, host)
    if host == 'elora':
        result = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(path / 'previous-app')],
                                capture_output=True, timeout=60)
        if result.returncode:
            raise RuntimeError('archived rollback app signature invalid')
    data = path / "rollback" / "t3-home/userdata" if host == "elora" else path / "rollback"
    _directory(data)
    database = data / "state.sqlite"
    if database.is_symlink() or not database.is_file():
        raise RuntimeError("rollback retention database missing")
    for database in (database, data / "statev2.sqlite"):
        if not database.exists():
            continue
        if database.is_symlink() or (Path(str(database) + "-wal").exists() and Path(str(database) + "-wal").stat().st_size):
            raise RuntimeError("rollback retention database is not quiescent")
        with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("rollback retention database unhealthy")
    return slots


def _audit(root, value):
    descriptor = os.open(root / "retention.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("rollback retention audit differs")
        stream.write(json.dumps(value, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _stamp(name):
    return re.sub(r'[^0-9]', '', name)[:14]


def _active(marker, host, probe):
    marker = Path(marker)
    if marker.resolve() != marker or marker.is_symlink():
        raise RuntimeError("current rollback marker is linked")
    info = marker.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise RuntimeError("current rollback marker identity differs")
    raw = marker.read_bytes()
    value = json.loads(raw)
    expected = "t3-desktop-apfs-v1" if host == "elora" else "t3-fork-backend-deployment-v1"
    current = Path(value["directory"])
    _directory(current)
    if (value.get("marker") != expected or current.parent != marker.parent
            or not RECEIPT.fullmatch(current.name)):
        raise RuntimeError("current rollback marker binding differs")
    data = current / "t3-home/userdata" if host == "elora" else current
    _directory(data)
    paths = [data / "state.sqlite"]
    if (data / "statev2.sqlite").exists():
        paths.append(data / "statev2.sqlite")
    if host == "elora":
        app = Path(value['previous_app'])
        _directory(app)
        if app.parent != Path('/Applications') or app.name != '.T3 Code (Alpha).previous.' + current.name + '.app':
            raise RuntimeError("current rollback app binding differs")
        app_info = app / 'Contents/Info.plist'
        if not plistlib.loads(app_info.read_bytes()).get('CFBundleIdentifier'):
            raise RuntimeError("current rollback app is incomplete")
        paths.append(app_info)
    def verify_app():
        if host == 'elora':
            result = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                                    capture_output=True, timeout=60)
            if result.returncode:
                raise RuntimeError('current rollback app signature invalid')
    verify_app()
    def versions():
        result = []
        for path in paths:
            entry = path.lstat()
            if (path.resolve() != path or not stat.S_ISREG(entry.st_mode)
                    or entry.st_uid != os.getuid()):
                raise RuntimeError("current rollback payload differs")
            wal = Path(str(path) + '-wal')
            if wal.exists() or wal.is_symlink():
                if wal.is_symlink() or wal.stat().st_size:
                    raise RuntimeError("current rollback has uncheckpointed writes")
            result.append((entry.st_dev, entry.st_ino, entry.st_size, entry.st_mtime_ns, entry.st_ctime_ns))
        return result
    probe(current)
    before = versions()
    for path in paths:
        if path.suffix != '.sqlite':
            continue
        with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise RuntimeError("current rollback database unhealthy")
    def recheck():
        if marker.read_bytes() != raw or versions() != before:
            raise RuntimeError("current rollback changed")
        probe(current)
        verify_app()
    recheck()
    return current, recheck


def _prune(root, host, apply, probe, retained_marker=None):
    if host not in ("elora", "millie"):
        raise RuntimeError("rollback retention host differs")
    directory = root / host
    result = {"host": host, "kept": None, "removed": [], "held": []}
    if not directory.exists():
        return result
    _directory(directory)
    candidates = sorted((path for path in directory.iterdir() if RECEIPT.fullmatch(path.name) and (path / "rollback").exists()), reverse=True)
    if not candidates:
        result['verification'] = 'no_archive_payload_no_health_claim'
        return result
    current = recheck_current = None
    if retained_marker is not None:
        try:
            current, recheck_current = _active(retained_marker, host, probe)
        except (RuntimeError, OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError):
            result['held'].append('current_rollback_unverified')
    if len(candidates) <= 1 and current is None:
        result["kept"] = candidates[0].name if candidates else None
        result["verification"] = "no_deletion_no_health_claim"
        return result
    keeper = current
    for path in candidates if current is None else []:
        try:
            _directory(path)
            _healthy(path, host)
            keeper = path
            result["kept"] = path.name
            break
        except (RuntimeError, OSError, ValueError, sqlite3.Error):
            result["held"].append(path.name)
    if keeper is None:
        return result
    result['kept'] = keeper.name
    if current is not None:
        result['retained_current'] = True
    for path in candidates:
        if _stamp(path.name) >= _stamp(keeper.name):
            continue
        try:
            _directory(path)
            probe(path)
            slots = _slots(path, host)
            if apply:
                control = Path.home() / "Codex_Workroom/task_evidence/otis-control"
                if any((control / name).exists() for name in ("STOP-ALL", "STOP-disk-retention")):
                    raise RuntimeError("rollback retention stopped")
                if not getattr(shutil.rmtree, "avoids_symlink_attacks", False):
                    raise RuntimeError("rollback retention safe removal unavailable")
                _audit(root, {"action": "delete_intent", "host": host, "receipt": path.name, "retained": keeper.name})
                if recheck_current is not None:
                    recheck_current()
                else:
                    _healthy(keeper, host)
                probe(path)
                _slots(path, host)
                for slot in slots:
                    shutil.rmtree(path / slot)
                _audit(root, {"action": "deleted_payloads", "host": host, "receipt": path.name, "retained": keeper.name})
            result.setdefault("removed" if apply else "eligible", []).append(path.name)
        except (RuntimeError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
            result["held"].append(path.name)
    return result


def prune(root, host, *, apply=False, probe=closed, retained_marker=None):
    root = Path(root)
    if not root.exists():
        return {"host": host, "kept": None, "removed": [], "held": []}
    if not apply:
        _directory(root)
        return _prune(root, host, False, probe, retained_marker)
    with retention_lock(root):
        return _prune(root, host, True, probe, retained_marker)


def archive(source, host, receipt, slot="rollback", archive_root=None):
    root = Path(archive_root) if archive_root is not None else Path.home() / ".local/share/t3-nightly/rollback-archive"
    with retention_lock(root):
        target = _archive(source, host, receipt, slot, root)
        _prune(root, host, True, closed)
        return target


if __name__ == "__main__":
    try:
        if sys.argv[1] == "prune":
            print(json.dumps(prune(Path(sys.argv[2]), sys.argv[3], apply="--apply" in sys.argv[4:])))
        elif sys.argv[1] == "archive":
            archive(Path(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5])
            print("superseded rollback verified locally; only the newest healthy archive is retained")
        else:
            raise RuntimeError("unknown archive operation")
    except Exception:
        print("rollback archive held; local originals retained", file=sys.stderr)
        sys.exit(1)
