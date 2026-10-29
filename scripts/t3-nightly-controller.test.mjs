import { it } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { runNightly, compareChecks } from "./t3-nightly-sync.mjs";
import { newLintDiagnostics } from "./t3-nightly-lint.mjs";

const taskId = "agenda-task:43f97c65571d4e89baa85b2349753c3d";
const tag = "v0.1.3-nightly.20261024.3643";

async function scenario(kind) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-nightly-synthetic-"));
  const repository = NodePath.join(root, "Worktrees/owner");
  const artifacts = NodePath.join(root, "artifacts");
  const followsMain = ["main", "dry-run"].includes(kind);
  NodeFS.mkdirSync(repository, { recursive: true });
  NodeFS.mkdirSync(artifacts);
  const git = (args, cwd = repository, allowFailure = false) => {
    const result = NodeChildProcess.spawnSync(
      "git",
      [
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "http.postBuffer=1048576",
        "-c",
        "http.maxRequestBuffer=10485760",
        ...args,
      ],
      {
        cwd,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    if (result.status !== 0 && !allowFailure) throw new Error(result.stderr);
    return { code: result.status, text: result.stdout.trim() };
  };
  const write = (base, file, text) => {
    const path = NodePath.join(base, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, text);
  };
  try {
    for (const name of ["origin", "upstream"]) git(["init", "--bare", NodePath.join(root, name)]);
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    write(repository, "src/old.ts", "export const original = 1;\n");
    if (kind === "budget")
      write(
        repository,
        "apps/server/src/provider/agentContextBudget.json",
        JSON.stringify({ tools: 20 }),
      );
    git(["add", "."]);
    git(["-c", "core.hooksPath=NUL", "commit", "-m", "initial fixture"]);
    const base = git(["rev-parse", "HEAD"]).text;
    git(["remote", "add", "origin", NodePath.join(root, "origin")]);
    git(["remote", "add", "upstream", NodePath.join(root, "upstream")]);
    write(repository, "docs/fork/FEATURES.md", "Preserve src/old.ts and src/fork.ts.\n");
    write(repository, "src/fork.ts", "export const fork = true;\n");
    if (kind === "conflict") write(repository, "src/old.ts", "export const original = 2;\n");
    if (kind === "budget") {
      write(
        repository,
        "apps/server/src/provider/agentContextBudget.json",
        JSON.stringify({ tools: 23 }),
      );
      write(repository, "docs/fork/agent-context-delta.json", JSON.stringify({ tools: 3 }));
    }
    git(["add", "."]);
    git(["-c", "core.hooksPath=NUL", "commit", "-m", "fork fixture"]);
    git(["branch", "feat/t3-workers-prototype"]);
    git(["push", "origin", "feat/t3-workers-prototype"]);
    const stale = git(["rev-parse", "HEAD"]).text;
    write(repository, "src/current-tip.ts", "export const current = true;\n");
    git(["add", "src/current-tip.ts"]);
    git(["-c", "core.hooksPath=NUL", "commit", "-m", "current fork tip"]);
    git(["push", "origin", "HEAD:refs/heads/feat/t3-workers-prototype"]);
    const fork = git(["rev-parse", "HEAD"]).text;
    if (followsMain) git(["push", "origin", "HEAD:refs/heads/main"]);
    git(["update-ref", "refs/remotes/origin/feat/t3-workers-prototype", stale]);
    const upstream = NodePath.join(root, "Worktrees/upstream-source");
    git(["worktree", "add", "--detach", upstream, base]);
    if (kind === "conflict") write(upstream, "src/old.ts", "export const original = 3;\n");
    else git(["mv", "src/old.ts", "src/new.ts"], upstream);
    if (kind === "budget")
      write(
        upstream,
        "apps/server/src/provider/agentContextBudget.json",
        JSON.stringify({ tools: 25 }),
      );
    git(["add", "."], upstream);
    git(["-c", "core.hooksPath=NUL", "commit", "-m", "upstream fixture"], upstream);
    git(["tag", tag], upstream);
    git(["push", "upstream", tag], upstream);
    if (followsMain) {
      write(upstream, "src/efficiency.ts", "export const compact = true;\n");
      git(["add", "src/efficiency.ts"], upstream);
      git(["-c", "core.hooksPath=NUL", "commit", "-m", "upstream main efficiency"], upstream);
      git(["push", "upstream", "HEAD:refs/heads/main"], upstream);
    }
    write(repository, ".vite-hooks/_/pre-commit", "#!/bin/sh\nexit 0\n");
    const config = {
      repository,
      ...(followsMain ? { forkBranch: "main", upstreamBranch: "main", autoPublish: true } : {}),
      node: process.execPath,
      artifactRoot: artifacts,
      releaseRoot: NodePath.join(root, "releases"),
      taskId,
      handoff: "synthetic-handoff",
      workerCapabilities: "synthetic-capabilities",
      otisCall: "synthetic-otis-call",
      taskLinkCheck: "synthetic-task-links",
    };
    const file = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(file, JSON.stringify(config));
    const notifications = [];
    let built = false;
    const io = {
      dryRun: kind === "dry-run",
      run(exe, args, cwd = repository, allowFailure = false) {
        if (exe === "git") {
          if (args.includes("push") && args.some((arg) => arg.endsWith(":refs/heads/main")))
            NodeAssert.equal(built, true);
          if (args[0] === "remote" && args[1] === "get-url")
            return {
              code: 0,
              text:
                args[2] === "origin"
                  ? "https://github.com/coolnether123/t3code.git"
                  : "https://github.com/pingdotgg/t3code.git",
            };
          return git(args, cwd, allowFailure);
        }
        if (args[0].endsWith("t3-build-job.mjs")) {
          const job = JSON.parse(NodeFS.readFileSync(args[1], "utf8"));
          if (NodePath.basename(job.command).toLowerCase() === "powershell.exe") {
            if (kind === "build-failure")
              return { code: 1, text: "synthetic production build failure" };
            const sha = git(["rev-parse", "HEAD"], job.cwd).text;
            const release = NodePath.join(config.releaseRoot, sha);
            write(release, "artifact.txt", "");
            write(
              release,
              "release.json",
              JSON.stringify({
                commit: sha,
                artifacts: [
                  {
                    path: "artifact.txt",
                    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                  },
                ],
              }),
            );
            built = true;
            return { code: 0, text: "synthetic production build" };
          }
          if (job.args[0].endsWith("t3-nightly-check.mjs")) {
            const baseline = job.cwd.includes("t3-baseline-");
            const failed =
              kind === "inherited" || kind === "unavailable" || (kind === "failure" && !baseline);
            const checks = [
              {
                name: "typecheck",
                exit: failed ? 1 : 0,
                classified: kind !== "unavailable",
                failures:
                  failed && kind !== "unavailable"
                    ? ["src/new.ts: error TS1234: synthetic diagnostic"]
                    : [],
              },
              { name: "tests", exit: 0, classified: true, failures: [] },
            ];
            NodeFS.mkdirSync(job.args[2], { recursive: true });
            NodeFS.writeFileSync(NodePath.join(job.args[2], "checks.json"), JSON.stringify(checks));
            return { code: failed ? 1 : 0, text: "synthetic owner checks" };
          }
          return { code: kind === "install-failure" ? 1 : 0, text: "synthetic frozen install" };
        }
        if (args[0].endsWith("t3-nightly-task-links.mjs")) {
          NodeAssert.equal(args[1], config.taskLinkCheck);
          NodeAssert.equal(
            args[2],
            `refs/remotes/origin/${followsMain ? "main" : "feat/t3-workers-prototype"}`,
          );
          NodeAssert.equal(
            args[3],
            followsMain
              ? git(["rev-parse", "refs/remotes/upstream/main"], cwd).text
              : git(["rev-parse", tag], cwd).text,
          );
          const message = git(["log", "-1", "--format=%B"], cwd).text;
          NodeAssert.equal(message.match(/Otis-Task:/g)?.length, 1);
          NodeAssert.ok(message.endsWith(`Otis-Task: ${taskId}`));
          return { code: 0, text: "synthetic agenda acceptance" };
        }
        if (args[0] === config.otisCall) {
          notifications.push(JSON.parse(NodeFS.readFileSync(args[3].slice(1), "utf8")));
          return { code: 0, text: "synthetic alert receipt" };
        }
        throw new Error("Unexpected external action in nightly fixture");
      },
    };
    const outcome = await runNightly(file, io);
    const readLedger = () =>
      NodeFS.readFileSync(NodePath.join(artifacts, "nightly-ledger.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const result = readLedger().at(-1);
    NodeAssert.equal(result.base, fork);
    NodeAssert.equal(
      git(["ls-remote", "origin", "refs/heads/feat/t3-workers-prototype"]).text.split(/\s/)[0],
      fork,
    );
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(config.releaseRoot, "auto-deploy-enabled")),
      false,
    );
    if (kind === "dry-run") {
      NodeAssert.equal(outcome.exitCode, 0, result.failure);
      NodeAssert.equal(result.result, "dry-run-passed", result.failure);
      NodeAssert.equal(notifications.length, 0);
      NodeAssert.equal(git(["ls-remote", "origin", "refs/heads/main"]).text.split(/\s/)[0], fork);
      NodeAssert.equal(git(["ls-remote", "origin", `refs/heads/${result.branch}`]).text, "");
      NodeAssert.equal(NodeFS.existsSync(result.worktree), false);
    } else if (["green", "inherited", "main", "budget"].includes(kind)) {
      if (kind === "budget") NodeAssert.deepEqual(result.contextBudget.resolved, { tools: 28 });
      NodeAssert.equal(
        result.result,
        followsMain ? "published" : "candidate-pushed",
        result.failure,
      );
      NodeAssert.equal(notifications.length, followsMain ? 0 : 1);
      NodeAssert.match(git(["show", `${result.commit}:docs/fork/FEATURES.md`]).text, /src\/new.ts/);
      NodeAssert.match(git(["show", `${result.commit}:src/fork.ts`]).text, /fork = true/);
      NodeAssert.equal(
        git(["ls-remote", "origin", `refs/heads/${result.branch}`]).text.split(/\s/)[0],
        result.commit,
      );
      if (followsMain) {
        NodeAssert.equal(
          git(["ls-remote", "origin", "refs/heads/main"]).text.split(/\s/)[0],
          result.commit,
        );
        NodeAssert.match(
          git(["show", `${result.commit}:src/efficiency.ts`]).text,
          /compact = true/,
        );
      }
      await runNightly(file, io);
      NodeAssert.equal(
        readLedger().at(-1).result,
        followsMain ? "already-synced" : "existing-candidate-needs-resume",
      );
    } else if (["unavailable", "install-failure"].includes(kind)) {
      NodeAssert.equal(
        result.result,
        kind === "unavailable" ? "verification-unavailable" : "dependency-verification-unavailable",
        result.failure,
      );
      NodeAssert.equal(notifications.length, 1);
      NodeAssert.equal(outcome.exitCode, 1);
      NodeAssert.ok(NodeFS.existsSync(NodePath.join(result.artifact, "NEEDS-PARENT.json")));
    } else {
      NodeAssert.equal(result.result, "needs-parent", result.failure);
      NodeAssert.equal(notifications.length, 1);
      NodeAssert.equal(outcome.exitCode, 1);
      const packet = JSON.parse(
        NodeFS.readFileSync(NodePath.join(result.artifact, "NEEDS-PARENT.json"), "utf8"),
      );
      NodeAssert.equal(packet.worktree, result.worktree);
      NodeAssert.equal(packet.branch, result.branch);
      NodeAssert.equal(packet.conflictCount, kind === "conflict" ? 1 : 0);
      NodeAssert.ok(NodeFS.existsSync(packet.packet));
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

it.each([
  "green",
  "conflict",
  "failure",
  "inherited",
  "unavailable",
  "main",
  "build-failure",
  "install-failure",
  "dry-run",
  "budget",
])(
  "nightly controller handles %s with isolated Git and synthetic check providers",
  async (kind) => {
    await scenario(kind);
  },
);

it("rejects new lint diagnostics and increased counts while allowing moved inherited diagnostics", () => {
  const inherited = {
    filename: "src/fork.ts",
    code: "rule",
    severity: "error",
    message: "Existing debt",
    labels: [{ line: 1 }],
  };
  const moved = { ...inherited, labels: [{ line: 20 }] };
  const added = { ...inherited, message: "New debt" };
  NodeAssert.deepEqual(newLintDiagnostics([moved, moved, added], [inherited]), [moved, added]);
  NodeAssert.deepEqual(newLintDiagnostics([], [inherited]), []);
  NodeAssert.deepEqual(newLintDiagnostics([{ ...moved, filename: "src/new.ts" }], [inherited]), [
    { ...moved, filename: "src/new.ts" },
  ]);
});

it.each(["format", "lint", "agent-context"])("never waives an inherited %s failure", (name) => {
  const failed = { name, exit: 1, classified: true, failures: ["same diagnostic"] };
  NodeAssert.equal(compareChecks([failed], [failed]), false);
});
