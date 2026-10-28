import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { scopedTaskGit } from "./t3-nightly-task-links.mjs";

NodeTest.test(
  "upstream exemption keeps every divergent fork commit in the task gate",
  async (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-imported-history-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const git = (_repository, ...args) => {
      const result = NodeChildProcess.spawnSync("git", ["-c", "core.hooksPath=NUL", ...args], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      NodeAssert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(root, "init");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "commit", "--allow-empty", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-b", "upstream");
    git(root, "commit", "--allow-empty", "-m", "third party without task trailer");
    const upstream = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-b", "fork", base);
    git(root, "commit", "--allow-empty", "-m", "owned commit with missing trailer");
    const owned = git(root, "rev-parse", "HEAD");
    git(root, "merge", "--no-ff", "upstream", "-m", "owned merge");
    const merge = git(root, "rev-parse", "HEAD");
    const original = git(root, "rev-list", "--reverse", `${base}..HEAD`).split("\n");
    NodeAssert.ok(original.includes(upstream));
    const scoped = scopedTaskGit(git, upstream);
    NodeAssert.deepEqual(
      (await scoped(root, "rev-list", "--reverse", `${base}..HEAD`)).split("\n"),
      [owned, merge],
    );
    NodeAssert.equal(await scoped(root, "rev-parse", "HEAD"), merge);
    NodeAssert.throws(() => scopedTaskGit(git, "not-a-pinned-object"), /pinned upstream/);
  },
);
