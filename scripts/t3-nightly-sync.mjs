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
      (!["format", "lint", "agent-context"].includes(c.name) &&
        c.classified &&
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
  const fallbackRoot = NodePath.dirname(NodePath.resolve(configFile));
  let config = {
    repository: fallbackRoot,
    artifactRoot: fallbackRoot,
    node: process.execPath,
    otisCall: "A:/Dev/Projects/Otis/tools/otis-call/otis-call.mjs",
  };
  let configFailure;
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(configFile, "utf8"));
    const required = ["repository", "artifactRoot", "node", "taskId", "releaseRoot"];
    if (!parsed?.pcUnattended) required.push("otisCall");
    if (!parsed || required.some((key) => typeof parsed[key] !== "string" || !parsed[key]))
      throw new Error("Nightly config is missing required paths or task identity");
    config = parsed;
  } catch (error) {
    configFailure = error;
  }
  const lock = NodeNet.createServer((s) => s.destroy());
  const pc = config.pcUnattended === true;
  const toolPath = [
    NodePath.dirname(config.node),
    config.pnpmBin,
    process.env.Path ?? process.env.PATH,
  ]
    .filter(Boolean)
    .join(NodePath.delimiter);
  const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const dryRun = io.dryRun ?? process.argv.includes("--dry-run");
  const deployOnlyIndex = process.argv.indexOf("--deploy-only");
  const deployOnly =
    io.deployOnly ?? (deployOnlyIndex < 0 ? null : (process.argv[deployOnlyIndex + 1] ?? ""));
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
      const commandArgs =
        exe === "git"
          ? [
              "-c",
              "core.longpaths=true",
              "-c",
              "http.postBuffer=1048576",
              "-c",
              "http.maxRequestBuffer=10485760",
              "-c",
              "gc.auto=0",
              "-c",
              "maintenance.auto=false",
              ...args,
            ]
          : args;
      const result = NodeChildProcess.spawnSync(exe, commandArgs, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: toolPath,
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
  const queue = (title, cwd, args, command = config.node) => {
    const definition = NodePath.join(artifact, `${NodeCrypto.randomUUID()}.job.json`);
    NodeFS.writeFileSync(
      definition,
      JSON.stringify({
        requestId: NodeCrypto.randomUUID(),
        taskId: config.taskId,
        title,
        command,
        args,
        cwd,
        outputs: [artifact],
        ...(pc && deployOnly === null ? { environment: { PATH: toolPath } } : {}),
        lane: "heavy",
        class: command === config.node ? "test-suite" : "build",
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
  let ownedTree = false;
  const skip = (result, reason) => {
    ledger.result = result;
    ledger.stopReason = reason;
    return ledger;
  };
  const worker = (reason) => {
    ledger.stopReason = reason;
    ledger.result = pc ? "failed" : "needs-parent";
  };
  const alert = () => {
    const packet = NodePath.join(artifact, "repair.md");
    NodeFS.writeFileSync(
      packet,
      `Resolve the Windows nightly sync at ${ledger.worktree ?? config.repository}. Stop: ${ledger.stopReason ?? ledger.result}. Preserve docs/fork/FEATURES.md and fork behavior. Read ${config.handoff} and result.json. Verify the candidate before publishing or deploying.\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(artifact, "NEEDS-PARENT.json"),
      JSON.stringify(
        {
          night,
          reason: ledger.stopReason ?? ledger.result,
          result: ledger.result,
          parentChatId: config.parentChatId ?? null,
          branch: ledger.branch ?? null,
          worktree: ledger.worktree ?? null,
          packet,
          conflictCount: ledger.conflicts?.filter(Boolean).length ?? 0,
        },
        null,
        2,
      ),
    );
    const notification = NodePath.join(artifact, "alert.json");
    NodeFS.writeFileSync(
      notification,
      JSON.stringify({
        requestId: `t3-nightly-${NodePath.basename(artifact)}`,
        title: "T3 nightly sync stopped",
        text: `Jared, T3 nightly sync stopped: ${ledger.stopReason ?? ledger.result}. Result: ${ledger.result}. Evidence: ${artifact}/NEEDS-PARENT.json. Parent: ${config.parentChatId ?? "unbound"}.`,
        category: "failures",
        priority: "urgent",
        speak: true,
        project: "t3code",
        taskId: config.taskId,
      }),
    );
    const notified = run(
      config.node,
      [config.otisCall, "call", "tell_jared", `@${notification}`],
      config.repository,
      true,
    );
    ledger.alertDelivered = notified.code === 0;
    if (!ledger.alertDelivered)
      ledger.alertFailure = "tell_jared failed; retained alert.json and NEEDS-PARENT.json";
  };
  const otisReceipt = async () => {
    const request = {
      requestId: NodeCrypto.randomUUID(),
      taskId: config.taskId,
      kind: "artifact",
      locator: NodePath.join(artifact, "result.json"),
      summary: "PC T3 nightly " + night + " " + ledger.result,
      repo: null,
      producedBy: { model: null, effort: null, runName: null },
    };
    const body = JSON.stringify(request);
    NodeFS.writeFileSync(NodePath.join(artifact, "otis-receipt-request.json"), body);
    // A Windows scheduled task has no chat origin. The loopback tracker accepts local jobs.
    const response = await fetch("http://127.0.0.1:5197/api/v1/tracker/outputs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Otis-Actor": "user:local" },
      body,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Otis tracker HTTP " + response.status);
    const receipt = await response.json();
    if (receipt.taskId !== config.taskId || !receipt.recordId?.startsWith("output:"))
      throw new Error("Otis returned an unexpected tracker receipt");
    return receipt.recordId;
  };
  const prepareRelease = (sha, tree) => {
    const release = NodePath.join(config.releaseRoot, sha);
    if (!NodeFS.existsSync(NodePath.join(release, "release.json"))) {
      if (
        queue(
          "Nightly production release build before publication",
          tree,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            NodePath.join(import.meta.dirname, "t3-prepare-release.ps1"),
            "-Commit",
            sha,
            "-Repository",
            tree,
            "-ReleaseRoot",
            config.releaseRoot,
            "-ArtifactRoot",
            artifact,
            ...(deployOnly === null ? [] : ["-PnpmBin", config.pnpmBin]),
          ],
          NodePath.join(
            process.env.SystemRoot ?? "C:/Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
        ) !== 0
      )
        throw new Error("Production build failed before publication");
    }
    const receipt = JSON.parse(NodeFS.readFileSync(NodePath.join(release, "release.json"), "utf8"));
    if (receipt.commit !== sha || !receipt.artifacts?.length)
      throw new Error("Production build receipt identity is invalid");
    for (const item of receipt.artifacts) {
      const file = NodePath.join(release, item.path);
      const hash = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
      if (hash.toLowerCase() !== item.sha256.toLowerCase())
        throw new Error("Production build artifact hash mismatch");
    }
    ledger.buildReceipt = NodePath.join(release, "release.json");
  };
  const deployPc = (sha) => {
    if (!NodeFS.existsSync(NodePath.join(config.releaseRoot, "auto-deploy-enabled")))
      return skip("deploy-disabled", "Windows release auto-deploy marker is missing");
    const deployment = run(
      config.node,
      [
        NodePath.join(import.meta.dirname, "t3-deploy.mjs"),
        "nightly",
        config.deployConfig,
        NodePath.join(config.releaseRoot, sha),
        ledger.liveBefore,
      ],
      config.repository,
      true,
    );
    let receipt;
    try {
      receipt = JSON.parse(deployment.text);
    } catch {
      throw new Error("Nightly deploy returned no transaction receipt");
    }
    ledger.deployId = receipt.id;
    if (receipt.result === "preflight-failed") {
      if (receipt.failure?.includes("Nightly deployment requires zero active turns"))
        return skip("skipped-busy", receipt.failure);
      return skip("skipped-deploy-preflight", receipt.failure);
    }
    if (deployment.code !== 0 || receipt.result !== "healthy")
      return skip("deploy-failed", "Deployment transaction: " + receipt.result);
    ledger.liveAfter = sha;
    ledger.result = "deployed";
    return ledger;
  };
  try {
    if (configFailure) throw configFailure;
    if (deployOnly !== null) {
      if (!pc || !/^[a-f0-9]{40}$/.test(deployOnly) || process.argv.includes("--observe"))
        throw new Error("--deploy-only requires a full commit SHA and the Jared PC nightly config");
      ledger.mode = "deploy-only";
    }
    lock.listen(config.lockName ?? "\\\\.\\pipe\\otis-t3-nightly-sync");
    await NodeEvents.once(lock, "listening");
    if (
      git("remote", "get-url", "origin") !== "https://github.com/coolnether123/t3code.git" ||
      git("remote", "get-url", "upstream") !== "https://github.com/pingdotgg/t3code.git"
    )
      throw new Error("Unexpected repository owner");
    const forkBranch = config.forkBranch ?? "feat/t3-workers-prototype";
    if (pc) {
      if (
        forkBranch !== "deploy/jared-pc-nightly" ||
        config.upstreamBranch !== "main" ||
        !/^[AF]:[\\/]/i.test(NodeFS.realpathSync(config.repository)) ||
        !/^[AF]:[\\/]/i.test(NodeFS.realpathSync(config.worktreeRoot)) ||
        !NodeFS.statSync(config.vp).isFile() ||
        !NodeFS.statSync(NodePath.join(config.pnpmBin, "pnpm.cmd")).isFile() ||
        NodePath.resolve(config.releaseRoot).toLowerCase() !==
          NodePath.resolve("A:/Runtime/T3CodeReleases").toLowerCase() ||
        NodePath.resolve(config.deployConfig) !==
          NodePath.resolve(config.releaseRoot, "deploy-config.json")
      )
        throw new Error("Expected Jared's PC fork, SSD worktree and native release paths");
    } else if (!["main", "feat/t3-workers-prototype"].includes(forkBranch))
      throw new Error("Unsupported fork branch");
    const forkRef = `refs/remotes/origin/${forkBranch}`;
    const fetchOptions = pc ? ["--no-tags", "--no-write-fetch-head"] : [];
    const refreshFork = () =>
      git("fetch", ...fetchOptions, "origin", `+refs/heads/${forkBranch}:${forkRef}`);
    refreshFork();
    let upstreamCommit;
    let tag;
    if (deployOnly === null && config.upstreamBranch === "main") {
      git("fetch", ...fetchOptions, "upstream", "+refs/heads/main:refs/remotes/upstream/main");
      upstreamCommit = git("rev-parse", "refs/remotes/upstream/main");
      tag = `upstream/main@${upstreamCommit.slice(0, 10)}`;
      ledger.sourceRef = "refs/heads/main";
    } else if (deployOnly === null) {
      const advertisedTags = git("ls-remote", "--tags", "--refs", "upstream", "v*-nightly.*")
        .split(/\r?\n/)
        .map((line) => {
          const [object, ref] = line.split(/\s+/);
          return { object, tag: ref?.replace("refs/tags/", "") };
        });
      tag = selectNightly(advertisedTags.map((entry) => entry.tag ?? ""));
      if (!tag) throw new Error("No upstream nightly tag");
      const nightlyRef = `refs/t3-sync/upstream/${tag}`;
      git("fetch", "upstream", `refs/tags/${tag}:${nightlyRef}`);
      if (
        git("rev-parse", nightlyRef) !== advertisedTags.find((entry) => entry.tag === tag)?.object
      )
        throw new Error("Upstream tag changed during fetch");
      upstreamCommit = git("rev-parse", `${nightlyRef}^{commit}`);
    }
    ledger.tag = tag;
    ledger.upstreamCommit = upstreamCommit;
    const published = git("rev-parse", forkRef);
    if (pc && deployOnly === null) {
      // Receive-pack authenticates even when the remote already points to this commit.
      ledger.publishReady =
        run(
          "git",
          [
            "-c",
            "push.followTags=false",
            "push",
            "--dry-run",
            "origin",
            published + ":refs/heads/" + forkBranch,
          ],
          config.repository,
          true,
        ).code === 0;
    }
    let base = published;
    const ancestor = (older, newer) => {
      const result = run(
        "git",
        ["merge-base", "--is-ancestor", older, newer],
        config.repository,
        true,
      );
      if (result.code !== 0 && result.code !== 1)
        throw new Error("Could not compare fork ancestry");
      return result.code === 0;
    };
    const verification = (sha) => NodePath.join(config.artifactRoot, "pc-verified", sha + ".json");
    if (pc) {
      const state = readJson(NodePath.join(config.releaseRoot, "state.json"));
      if (state.pending)
        return skip("skipped-deploy-pending", "Windows release recovery is pending");
      const live = NodePath.basename(state.current);
      if (
        !/^[a-f0-9]{40}$/.test(live) ||
        NodePath.resolve(state.current) !== NodePath.resolve(config.releaseRoot, live) ||
        readJson(NodePath.join(state.current, "release.json")).commit !== live
      )
        throw new Error("Current Windows release identity could not be verified");
      ledger.liveBefore = live;
      if (!ancestor(live, published)) {
        if (!ancestor(published, live))
          return skip(
            "skipped-fork-diverged",
            "The published PC fork and live release have diverged",
          );
        base = live;
      }
    }
    ledger.base = base;
    if (pc) {
      const proof = run(
        config.node,
        [NodePath.join(import.meta.dirname, "t3-deploy.mjs"), "owners", config.deployConfig],
        config.repository,
        true,
      );
      if (proof.code !== 0) throw new Error("Cannot attest to the two Windows release supervisors");
      const owners = JSON.parse(proof.text);
      if (
        owners.length !== 2 ||
        owners.some((owner) => NodePath.basename(owner.release) !== ledger.liveBefore)
      )
        throw new Error("Live Windows release changed during nightly preparation");
      ledger.ownerModes = owners.map((owner) => owner.mode);
    }
    if (deployOnly !== null) {
      const localFork = `refs/heads/${forkBranch}`;
      if (deployOnly !== published || git("rev-parse", localFork) !== deployOnly)
        throw new Error("Deploy-only requires the same exact local and published PC fork tip");
      if (base !== published) throw new Error("Deploy-only cannot move the live PC fork backward");
      ledger.commit = deployOnly;
      if (deployOnly === ledger.liveBefore)
        return skip("already-synced", "The requested PC fork tip is already live");
      if (dryRun) {
        ledger.result = "dry-run-passed";
        return ledger;
      }
      prepareRelease(deployOnly, config.repository);
      refreshFork();
      if (git("rev-parse", forkRef) !== deployOnly || git("rev-parse", localFork) !== deployOnly)
        return skip("skipped-fork-advanced", "The PC fork advanced during release preparation");
      return deployPc(deployOnly);
    }
    if (process.argv.includes("--observe")) {
      ledger.sourceIntegrated =
        run("git", ["cat-file", "-e", `${base}:docs/fork/FEATURES.md`], config.repository, true)
          .code === 0;
      ledger.alreadySynced =
        run("git", ["merge-base", "--is-ancestor", upstreamCommit, base], config.repository, true)
          .code === 0;
      ledger.result = "observed";
      return ledger;
    }
    if (
      run("git", ["cat-file", "-e", `${base}:docs/fork/FEATURES.md`], config.repository, true)
        .code !== 0
    ) {
      ledger.result = "awaiting-source-integration";
      return ledger;
    }
    if (
      !dryRun &&
      run("git", ["merge-base", "--is-ancestor", upstreamCommit, base], config.repository, true)
        .code === 0
    ) {
      if (pc && base !== ledger.liveBefore && NodeFS.existsSync(verification(base))) {
        const proof = readJson(verification(base));
        if (
          proof.commit !== base ||
          NodePath.resolve(proof.buildReceipt) !==
            NodePath.resolve(config.releaseRoot, base, "release.json") ||
          !NodeFS.existsSync(proof.buildReceipt)
        )
          throw new Error("Published candidate verification receipt is invalid");
        ledger.commit = base;
        ledger.buildReceipt = proof.buildReceipt;
        return deployPc(base);
      }
      return skip("already-synced", "The selected upstream commit is already integrated");
    }
    if (pc) {
      const preview = run(
        "git",
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, upstreamCommit],
        config.repository,
        true,
      );
      if (preview.code === 1) {
        ledger.conflicts = preview.text.split(/\r?\n/).slice(1).filter(Boolean);
        if (!ledger.conflicts.length)
          throw new Error("Merge preview failed without conflict paths");
        return skip(
          "skipped-conflicts",
          "Upstream merge has " + ledger.conflicts.length + " conflicts",
        );
      }
      if (preview.code !== 0) throw new Error("Upstream merge preview failed");
    }
    if (pc && !ledger.publishReady)
      return skip(
        "publish-unavailable",
        "Scheduled Windows account could not authenticate to the PC fork",
      );
    const branch = `sync/t3-nightly-${night}-${base.slice(0, 8)}${dryRun ? `-dry-${NodeCrypto.randomUUID().slice(0, 8)}` : ""}`;
    if (
      !pc &&
      run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        config.repository,
        true,
      ).code === 0
    ) {
      ledger.branch = branch;
      ledger.result = "existing-candidate-needs-resume";
      return ledger;
    }
    const tree = NodePath.join(
      config.worktreeRoot ?? NodePath.dirname(config.repository),
      `t3-sync-${night}-${NodeCrypto.randomUUID().slice(0, 8)}`,
    );
    NodeFS.mkdirSync(NodePath.dirname(tree), { recursive: true });
    if (
      NodePath.dirname(NodePath.resolve(tree)) !==
      NodePath.resolve(config.worktreeRoot ?? NodePath.dirname(config.repository))
    )
      throw new Error("Unsafe candidate worktree path");
    ledger.worktree = tree;
    ledger.branch = pc ? forkBranch : branch;
    git("worktree", "add", ...(pc ? ["--detach"] : ["-b", branch]), tree, base);
    ownedTree = true;
    const merge = run("git", ["merge", "--no-ff", "--no-commit", upstreamCommit], tree, true);
    if (merge.code !== 0) {
      ledger.conflicts = run("git", ["diff", "--name-only", "--diff-filter=U"], tree).text.split(
        /\r?\n/,
      );
      if (pc && ledger.conflicts.some(Boolean))
        return skip("skipped-conflicts", "Conflicts appeared during the candidate merge");
      const budgetPath = "apps/server/src/provider/agentContextBudget.json";
      if (ledger.conflicts.includes(budgetPath)) {
        const deltaPath = "docs/fork/agent-context-delta.json";
        try {
          const delta = JSON.parse(run("git", ["show", `${base}:${deltaPath}`], tree).text);
          const ancestor = run("git", ["merge-base", base, upstreamCommit], tree).text;
          const original = JSON.parse(run("git", ["show", `${ancestor}:${budgetPath}`], tree).text);
          const fork = JSON.parse(run("git", ["show", `${base}:${budgetPath}`], tree).text);
          const upstream = JSON.parse(
            run("git", ["show", `${upstreamCommit}:${budgetPath}`], tree).text,
          );
          if (
            Object.keys(upstream).some(
              (key) =>
                !Number.isSafeInteger(delta[key]) || fork[key] !== original[key] + delta[key],
            )
          )
            throw new Error("Documented fork delta no longer matches the fork budget");
          const resolved = Object.fromEntries(
            Object.entries(upstream).map(([key, value]) => [key, value + delta[key]]),
          );
          NodeFS.writeFileSync(
            NodePath.join(tree, budgetPath),
            JSON.stringify(resolved, null, 2) + "\n",
          );
          run("git", ["add", "--", budgetPath], tree);
          ledger.contextBudget = { upstream, delta, resolved };
          ledger.conflicts = ledger.conflicts.filter((path) => path !== budgetPath);
        } catch (error) {
          worker(
            `Context budget conflict: upstream numbers plus ${deltaPath} could not be verified. ${String(error)}`,
          );
          return ledger;
        }
      }
      if (ledger.conflicts.filter(Boolean).length) {
        worker(`Merge conflicts: ${ledger.conflicts.join(", ")}`);
        return ledger;
      }
      if (!ledger.contextBudget) {
        worker("Merge failed without conflicts; inspect commands.log");
        return ledger;
      }
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
    const vp = config.vp ?? NodePath.join(config.repository, "node_modules/vite-plus/bin/vp");
    if (queue("Nightly frozen dependency install", tree, [vp, "i", "--frozen-lockfile"]) !== 0) {
      ledger.result = "dependency-verification-unavailable";
      return ledger;
    }
    const candidateChecks = NodePath.join(artifact, "candidate");
    queue("Nightly all-package typecheck and affected tests", tree, [
      NodePath.join(import.meta.dirname, "t3-nightly-check.mjs"),
      tree,
      candidateChecks,
      fileJson,
      base,
    ]);
    const candidate = JSON.parse(
      NodeFS.readFileSync(NodePath.join(candidateChecks, "checks.json"), "utf8"),
    );
    if (candidate.some((check) => check.exit !== 0 && !check.classified)) {
      ledger.result = "verification-unavailable";
      ledger.failedChecks = candidate.filter((check) => check.exit !== 0);
      return ledger;
    }
    if (!candidate.every((c) => c.exit === 0)) {
      const tagSha = upstreamCommit;
      const key = NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify({
            tagSha,
            base,
            files,
            lintChecker: NodeFS.readFileSync(
              NodePath.join(import.meta.dirname, "t3-nightly-lint.mjs"),
              "utf8",
            ),
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
        ledger.baselineWorktree = baseline;
        if (
          queue("Nightly baseline frozen install", baseline, [vp, "i", "--frozen-lockfile"]) !== 0
        ) {
          ledger.result = "baseline-verification-unavailable";
          return ledger;
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
        return ledger;
      }
      if (!compareChecks(candidate, baselineChecks)) {
        worker(
          "Candidate has failures absent from the classified baseline; inspect candidate and cached baseline",
        );
        return ledger;
      }
      ledger.inheritedFailures = candidate.filter((c) => c.exit !== 0);
    }
    const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    const hooks = NodePath.join(NodePath.dirname(commonDir), ".vite-hooks/_");
    if (!NodeFS.existsSync(NodePath.join(hooks, "pre-commit")))
      throw new Error("Required commit hooks are missing");
    if (
      NodeFS.existsSync(run("git", ["rev-parse", "--git-path", "MERGE_HEAD"], tree).text) ||
      run("git", ["status", "--porcelain", "--untracked-files=no"], tree).text
    )
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
    prepareRelease(sha, tree);
    run(
      config.node,
      [
        NodePath.join(import.meta.dirname, "t3-nightly-task-links.mjs"),
        config.taskLinkCheck,
        forkRef,
        upstreamCommit,
      ],
      tree,
    );
    if (dryRun) {
      refreshFork();
      if (git("rev-parse", forkRef) !== published) throw new Error("Fork advanced during dry run");
      run(
        "git",
        [
          "-c",
          "push.followTags=false",
          "push",
          "--dry-run",
          "origin",
          `${sha}:refs/heads/${forkBranch}`,
        ],
        tree,
      );
      ledger.result = "dry-run-passed";
      return ledger;
    }
    if (pc) {
      const file = verification(sha);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(
        file,
        JSON.stringify({ commit: sha, buildReceipt: ledger.buildReceipt }),
      );
      refreshFork();
      if (git("rev-parse", forkRef) !== published)
        return skip("skipped-fork-advanced", "The published PC fork advanced during verification");
      run(
        "git",
        ["-c", "push.followTags=false", "push", "origin", sha + ":refs/heads/" + forkBranch],
        tree,
      );
      ledger.published = true;
      return deployPc(sha);
    }
    run("git", ["-c", "push.followTags=false", "push", "-u", "origin", branch], tree);
    ledger.result = "candidate-pushed";
    const deployEnabled = NodeFS.existsSync(
      NodePath.join(config.releaseRoot, "auto-deploy-enabled"),
    );
    if (config.autoPublish || deployEnabled) {
      refreshFork();
      if (git("rev-parse", forkRef) !== base)
        throw new Error("Fork advanced; candidate requires reintegration");
      run(
        "git",
        ["-c", "push.followTags=false", "push", "origin", `${sha}:refs/heads/${forkBranch}`],
        tree,
      );
      ledger.result = "published";
    }
    if (deployEnabled) {
      const deployed = run(
        NodePath.join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
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
  } finally {
    if (ledger.baselineWorktree) {
      const removed = run(
        "git",
        ["worktree", "remove", "--force", ledger.baselineWorktree],
        config.repository,
        true,
      );
      if (removed.code !== 0) {
        ledger.cleanupFailure = "Could not remove the owned upstream baseline worktree";
        if (!pc) worker(ledger.cleanupFailure);
      }
    }
    if (
      ownedTree &&
      (pc || ["published", "deployed", "already-synced", "dry-run-passed"].includes(ledger.result))
    ) {
      const removed = run(
        "git",
        ["worktree", "remove", "--force", ledger.worktree],
        config.repository,
        true,
      );
      ledger.worktreeRemoved = removed.code === 0;
      if (!ledger.worktreeRemoved) {
        ledger.cleanupFailure = "Could not remove the owned candidate worktree";
        if (!pc) worker(ledger.cleanupFailure);
      }
    }
    ledger.exitCode =
      ["published", "deployed", "already-synced", "dry-run-passed", "observed"].includes(
        ledger.result,
      ) || ledger.result.startsWith("skipped-")
        ? 0
        : 1;
    if (pc && ledger.cleanupFailure) ledger.exitCode = 1;
    if (ledger.exitCode !== 0 && !pc) {
      try {
        alert();
      } catch (error) {
        ledger.alertFailure = String(error);
      }
    }
    ledger.finishedAt = new Date().toISOString();
    NodeFS.writeFileSync(NodePath.join(artifact, "result.json"), JSON.stringify(ledger, null, 2));
    if (pc) {
      try {
        ledger.otisOutputId = await otisReceipt();
        ledger.otisReceiptRegistered = true;
      } catch (error) {
        ledger.otisReceiptRegistered = false;
        ledger.otisReceiptFailure = error.message;
        ledger.exitCode = 1;
      }
      NodeFS.writeFileSync(NodePath.join(artifact, "result.json"), JSON.stringify(ledger, null, 2));
    }
    NodeFS.appendFileSync(
      NodePath.join(config.artifactRoot, "nightly-ledger.jsonl"),
      JSON.stringify(ledger) + "\n",
    );
    if (lock.listening)
      await new Promise((resolve, reject) =>
        lock.close((error) => (error ? reject(error) : resolve())),
      );
  }
  return ledger;
}
if (process.argv[1] === import.meta.filename) {
  const result = await runNightly(process.argv[2]);
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}
