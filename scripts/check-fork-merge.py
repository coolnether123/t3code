"""Review fork delta lost in a merge and newly repeated top-level JS/TS declarations."""
import collections
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args])


def stats(*revisions):
    records = git("diff", "--numstat", "-z", "--no-renames", *revisions).split(b"\0")
    result = {}
    for row in filter(None, records):
        added, removed, path = row.split(b"\t", 2)
        if added != b"-":
            result[path] = int(added) + int(removed)
    return result


declaration = re.compile(
    rb"^(?:export\s+(?:default\s+)?)?(?:(?:declare|abstract|async)\s+)?"
    rb"(class|interface|type|function\*?|enum|const|let|var)[ \t]+([\w$]+)", re.M
)


def symbols(reader, revision, path):
    reader.stdin.write(revision + b":" + path + b"\n")
    reader.stdin.flush()
    header = reader.stdout.readline()
    if header.endswith(b" missing\n"):
        return collections.Counter()
    size = int(header.rsplit(b" ", 1)[1])
    data = reader.stdout.read(size)
    if len(data) != size or reader.stdout.read(1) != b"\n":
        raise ValueError("Incomplete git cat-file response")
    return collections.Counter(declaration.findall(data))


def main():
    fork = git("rev-parse", "HEAD").strip()
    upstream = git("rev-parse", "MERGE_HEAD").strip()
    base = git("merge-base", fork, upstream).strip()
    staged = git("write-tree").strip()
    before = stats(base, fork)
    after = stats(upstream, staged)
    touched = set(stats(fork, staged))
    duplicates = 0
    shrank = 0
    with subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE) as reader:
        for path, old in sorted(before.items()):
            label = path.decode("utf-8", "backslashreplace")
            new = after.get(path, 0)
            if new < old:
                shrank += 1
                print(f"SHRANK {label}: fork delta {old} -> {new} lines")
            if path not in touched or path not in after or not re.search(rb"\.[cm]?[jt]sx?$", path):
                continue
            merged = symbols(reader, staged, path)
            repeated = {key for key, count in merged.items() if count > 1}
            if repeated:
                parents = symbols(reader, fork, path) | symbols(reader, upstream, path)
                for key in sorted(repeated):
                    if merged[key] > parents[key]:
                        duplicates += 1
                        name = b" ".join(key).decode()
                        print(f"DUPLICATE {label}: {name} occurs {merged[key]} times")
        reader.stdin.close()
        if reader.wait():
            raise RuntimeError("git cat-file failed")
    print(f"{len(before)} fork text files, {shrank} smaller deltas, {duplicates} new duplicates")
    return int(bool(duplicates))


if __name__ == "__main__":
    sys.exit(main())
