import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";

export function selectNightly(tags) {
  return tags
    .filter((t) => /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(t))
    .sort((a, b) => {
      const aa = a.match(/nightly\.(\d+)\.(\d+)$/);
      const bb = b.match(/nightly\.(\d+)\.(\d+)$/);
      return Number(aa[1]) - Number(bb[1]) || Number(aa[2]) - Number(bb[2]) || a.localeCompare(b);
    })
    .at(-1);
}
export function compareChecks(candidate, baseline) {
  return candidate.every(
    (c) =>
      c.exit === 0 ||
      (c.classified &&
        c.failures.length > 0 &&
        baseline.some(
          (b) =>
            b.name === c.name &&
            b.classified &&
            b.exit !== 0 &&
            JSON.stringify(c.failures) === JSON.stringify(b.failures),
        )),
  );
}
export async function runNightly(configFile, io = {}) {
  const config = JSON.parse(NodeFS.readFileSync(configFile, "utf8"));
  const lock = NodeNet.createServer((s) => s.destroy());
  lock.listen("\\\\.\\pipe\\otis-t3-nightly-sync");
  await NodeEvents.once(lock, "listening");
  const night = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const artifact = NodePath.join(
    config.artifactRoot,
    `nightly-${night}-${NodeCrypto.randomUUID()}`,
  );
  NodeFS.mkdirSync(artifact, { recursive: true });
  const ledger = { night, startedAt: new Date().toISOString(), artifact, result: "failed" };
  const run =
    io.run ??
    ((exe, args, cwd = config.repository, allowFailure = false) => {
      const commandArgs = exe === "git" ? ["-c", "core.longpaths=true", ...args] : args;
      const result = NodeChildProcess.spawnSync(exe, commandArgs, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `${NodePath.dirname(config.node)};${process.env.PATH}`,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
        },
      });
      NodeFS.appendFileSync(
        NodePath.join(artifact, "commands.log"),
        `${JSON.stringify({ exe, args, cwd, exit: result.status })}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`,
      );
      if (result.status !== 0 && !allowFailure)
        throw new Error(`Command failed: ${NodePath.basename(exe)} exit ${result.status}`);
      return { code: result.status, text: result.stdout?.trim() ?? "" };
    });
  const git = (...args) => run("git", args).text;
  const queue = (title, cwd, args) => {
    const definition = NodePath.join(artifact, `${NodeCrypto.randomUUID()}.job.json`);
    NodeFS.writeFileSync(
      definition,
      JSON.stringify({
        requestId: NodeCrypto.randomUUID(),
        taskId: config.taskId,
        title,
        command: config.node,
        args,
        cwd,
        outputs: [artifact],
        lane: "heavy",
        class: "test-suite",
      }),
    );
    // The nightly controller is not a build job. Only its bounded owner checks enter the queue.
    return run(
      config.node,
      [NodePath.join(import.meta.dirname, "t3-build-job.mjs"), definition],
      config.repository,
      true,
    ).code;
  };
  const worker = (reason) => {
    const packet = NodePath.join(artifact, "repair.md");
    NodeFS.writeFileSync(
      packet,
      `Activate Otis.\n\nResolve the Windows nightly sync candidate at ${ledger.worktree ?? config.repository}. ${reason}. Preserve docs/fork/FEATURES.md and the current fork behavior. Read ${config.handoff} for prior evidence. Verify, commit and push only the sync candidate. Do not deploy, restart, install supervisors, touch Macs or enable auto-deploy. Report the exact remaining gate.\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(artifact, "NEEDS-PARENT.json"),
      JSON.stringify(
        {
          night,
          branch: ledger.branch ?? null,
          worktree: ledger.worktree ?? null,
          packet,
          conflictCount: ledger.conflicts?.filter(Boolean).length ?? 0,
        },
        null,
        2,
      ),
    );
    ledger.result = "needs-parent";
  };
  try {
    if (
      git("remote", "get-url", "origin") !== "https://github.com/coolnether123/t3code.git" ||
      git("remote", "get-url", "upstream") !== "https://github.com/pingdotgg/t3code.git"
    )
      throw new Error("Unexpected repository owner");
    git(
      "fetch",
      "origin",
      "+refs/heads/feat/t3-workers-prototype:refs/remotes/origin/feat/t3-workers-prototype",
    );
    const advertisedTags = git("ls-remote", "--tags", "--refs", "upstream", "v*-nightly.*")
      .split(/\r?\n/)
      .map((line) => {
        const [object, ref] = line.split(/\s+/);
        return { object, tag: ref?.replace("refs/tags/", "") };
      });
    const tag = selectNightly(advertisedTags.map((entry) => entry.tag ?? ""));
    if (!tag) throw new Error("No upstream nightly tag");
    ledger.tag = tag;
    const nightlyRef = `refs/t3-sync/upstream/${tag}`;
    git("fetch", "upstream", `refs/tags/${tag}:${nightlyRef}`);
    if (git("rev-parse", nightlyRef) !== advertisedTags.find((entry) => entry.tag === tag)?.object)
      throw new Error("Upstream tag changed during fetch");
    const upstreamCommit = git("rev-parse", `${nightlyRef}^{commit}`);
    ledger.upstreamCommit = upstreamCommit;
    const base = git("rev-parse", "origin/feat/t3-workers-prototype");
    ledger.base = base;
    if (process.argv.includes("--observe")) {
      ledger.sourceIntegrated =
        run("git", ["cat-file", "-e", `${base}:docs/fork/FEATURES.md`], config.repository, true)
          .code === 0;
      ledger.alreadySynced =
        run("git", ["merge-base", "--is-ancestor", upstreamCommit, base], config.repository, true)
          .code === 0;
      ledger.result = "observed";
      return;
    }
    if (
      run("git", ["cat-file", "-e", `${base}:docs/fork/FEATURES.md`], config.repository, true)
        .code !== 0
    ) {
      ledger.result = "awaiting-source-integration";
      return;
    }
    if (
      run("git", ["merge-base", "--is-ancestor", upstreamCommit, base], config.repository, true)
        .code === 0
    ) {
      ledger.result = "already-synced";
      return;
    }
    const branch = `sync/t3-nightly-${night}-${base.slice(0, 8)}`;
    if (
      run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        config.repository,
        true,
      ).code === 0
    ) {
      ledger.branch = branch;
      ledger.result = "existing-candidate-needs-resume";
      return;
    }
    const tree = NodePath.join(
      NodePath.dirname(config.repository),
      `t3-sync-${night}-${NodeCrypto.randomUUID().slice(0, 8)}`,
    );
    ledger.worktree = tree;
    ledger.branch = branch;
    git("worktree", "add", "-b", branch, tree, base);
    const merge = run("git", ["merge", "--no-ff", "--no-commit", upstreamCommit], tree, true);
    if (merge.code !== 0) {
      ledger.conflicts = run("git", ["diff", "--name-only", "--diff-filter=U"], tree).text.split(
        /\r?\n/,
      );
      if (ledger.conflicts.filter(Boolean).length)
        worker(`Merge conflicts: ${ledger.conflicts.join(", ")}`);
      else worker("Merge failed without conflicts; inspect commands.log");
      return;
    }
    const inventory = NodePath.join(tree, "docs/fork/FEATURES.md");
    let features = NodeFS.readFileSync(inventory, "utf8");
    for (const row of run(
      "git",
      ["diff", "--name-status", "--find-renames", base],
      tree,
    ).text.split(/\r?\n/)) {
      const [status, from, to] = row.split("\t");
      if (status.startsWith("R") && from && to) features = features.replaceAll(from, to);
    }
    NodeFS.writeFileSync(inventory, features);
    run("git", ["add", "--", "docs/fork/FEATURES.md"], tree);
    const files = run("git", ["diff", "--name-only", base], tree)
      .text.split(/\r?\n/)
      .filter(Boolean);
    const fileJson = NodePath.join(artifact, "changed.json");
    NodeFS.writeFileSync(fileJson, JSON.stringify(files));
    const vp = NodePath.join(config.repository, "node_modules/vite-plus/bin/vp");
    if (queue("Nightly frozen dependency install", tree, [vp, "i", "--frozen-lockfile"]) !== 0) {
      ledger.result = "dependency-verification-unavailable";
      return;
    }
    const candidateChecks = NodePath.join(artifact, "candidate");
    queue("Nightly all-package typecheck and affected tests", tree, [
      NodePath.join(import.meta.dirname, "t3-nightly-check.mjs"),
      tree,
      candidateChecks,
      fileJson,
    ]);
    const candidate = JSON.parse(
      NodeFS.readFileSync(NodePath.join(candidateChecks, "checks.json"), "utf8"),
    );
    if (candidate.some((check) => check.exit !== 0 && !check.classified)) {
      ledger.result = "verification-unavailable";
      ledger.failedChecks = candidate.filter((check) => check.exit !== 0);
      return;
    }
    if (!candidate.every((c) => c.exit === 0)) {
      const tagSha = upstreamCommit;
      const key = NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify({
            tagSha,
            files,
            node: process.version,
            checker: NodeFS.readFileSync(
              NodePath.join(import.meta.dirname, "t3-nightly-check.mjs"),
              "utf8",
            ),
          }),
        )
        .digest("hex");
      const cache = NodePath.join(config.artifactRoot, "baseline-cache", key);
      if (!NodeFS.existsSync(NodePath.join(cache, "checks.json"))) {
        const baseline = NodePath.join(NodePath.dirname(tree), `t3-baseline-${key.slice(0, 12)}`);
        git("worktree", "add", "--detach", baseline, tagSha);
        if (
          queue("Nightly baseline frozen install", baseline, [vp, "i", "--frozen-lockfile"]) !== 0
        ) {
          ledger.result = "baseline-verification-unavailable";
          return;
        }
        queue("Nightly same-tag baseline", baseline, [
          NodePath.join(import.meta.dirname, "t3-nightly-check.mjs"),
          baseline,
          cache,
          fileJson,
        ]);
      }
      const baselineChecks = JSON.parse(
        NodeFS.readFileSync(NodePath.join(cache, "checks.json"), "utf8"),
      );
      if (baselineChecks.some((check) => check.exit !== 0 && !check.classified)) {
        ledger.result = "baseline-verification-unavailable";
        return;
      }
      if (!compareChecks(candidate, baselineChecks)) {
        worker(
          "Candidate has failures absent from the classified baseline; inspect candidate and cached baseline",
        );
        return;
      }
      ledger.inheritedFailures = candidate.filter((c) => c.exit !== 0);
    }
    const hooks = NodePath.join(config.repository, "../../GitHub/t3code/.vite-hooks/_");
    if (!NodeFS.existsSync(NodePath.join(hooks, "pre-commit")))
      throw new Error("Required commit hooks are missing");
    run(
      "git",
      [
        "-c",
        "core.hooksPath=" + hooks,
        "commit",
        "-m",
        `chore(sync): integrate ${tag}\n\nOtis-Task: ${config.taskId}`,
      ],
      tree,
    );
    const sha = run("git", ["rev-parse", "HEAD"], tree).text;
    ledger.commit = sha;
    run(
      config.node,
      [
        NodePath.join(import.meta.dirname, "t3-nightly-task-links.mjs"),
        config.taskLinkCheck,
        "refs/remotes/origin/feat/t3-workers-prototype",
        upstreamCommit,
      ],
      tree,
    );
    run("git", ["-c", "push.followTags=false", "push", "-u", "origin", branch], tree);
    ledger.result = "candidate-pushed";
    if (NodeFS.existsSync(NodePath.join(config.releaseRoot, "auto-deploy-enabled"))) {
      git(
        "fetch",
        "origin",
        "+refs/heads/feat/t3-workers-prototype:refs/remotes/origin/feat/t3-workers-prototype",
      );
      if (git("rev-parse", "origin/feat/t3-workers-prototype") !== base)
        throw new Error("Fork advanced; candidate requires reintegration");
      run(
        "git",
        [
          "-c",
          "push.followTags=false",
          "push",
          "origin",
          `${sha}:refs/heads/feat/t3-workers-prototype`,
        ],
        tree,
      );
      const deployed = run(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          NodePath.join(tree, "scripts/t3-deploy.ps1"),
          "-Commit",
          sha,
          "-Config",
          config.deployConfig,
        ],
        tree,
        true,
      );
      if (deployed.code !== 0) throw new Error("Deployment failed; inspect deployment receipt");
      ledger.result = "deployed";
    }
  } catch (error) {
    ledger.failure = String(error);
    worker(ledger.failure);
    process.exitCode = 1;
  } finally {
    ledger.finishedAt = new Date().toISOString();
    NodeFS.writeFileSync(NodePath.join(artifact, "result.json"), JSON.stringify(ledger, null, 2));
    NodeFS.appendFileSync(
      NodePath.join(config.artifactRoot, "nightly-ledger.jsonl"),
      JSON.stringify(ledger) + "\n",
    );
    await new Promise((resolve, reject) =>
      lock.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
if (process.argv[1] === import.meta.filename) await runNightly(process.argv[2]);
