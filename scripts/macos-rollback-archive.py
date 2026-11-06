#!/usr/bin/env python3
"""Recoverable local retirement. No network, userdata export, or deletion."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True

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


def archive(source, host, receipt, slot="rollback", archive_root=None):
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


if __name__ == "__main__":
    try:
        if sys.argv[1] != "archive":
            raise RuntimeError("unknown archive operation")
        archive(Path(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5])
        print("superseded rollback cloned to its recoverable local archive; no bytes freed")
    except Exception:
        print("rollback archive held; local originals retained", file=sys.stderr)
        sys.exit(1)
