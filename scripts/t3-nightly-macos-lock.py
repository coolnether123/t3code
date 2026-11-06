#!/usr/bin/env python3
"""An OS-owned lock survives exec and disappears automatically after a crash."""
import fcntl
import json
import os
from pathlib import Path
import sys


def acquire(root):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root / "nightly.lock"
    if root.is_symlink() or path.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError("nightly lock ownership differs")
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        os.close(descriptor)
        raise
    os.set_inheritable(descriptor, True)
    return descriptor


if __name__ == "__main__":
    try:
        path = Path(sys.argv[1])
        if path.is_symlink() or not path.is_absolute() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
            raise RuntimeError("private nightly configuration required")
        config = json.loads(path.read_text())
        descriptor = acquire(config["artifactRoot"])
        env = dict(os.environ, T3_NIGHTLY_LOCKED="1")
        if any(arg != "--preview" for arg in sys.argv[2:]):
            raise RuntimeError("unknown nightly wrapper option")
        os.execve(config["node"], [config["node"], str(Path(config["repository"]) / "scripts/t3-nightly-sync.mjs"), str(path), *sys.argv[2:]], env)
    except BlockingIOError:
        print("nightly controller already running")
    except Exception:
        print("nightly lock held; no update started", file=sys.stderr)
        sys.exit(1)
