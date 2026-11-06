import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { resolveNightlyConflict } from "./t3-nightly-resolver.mjs";

export const nightlyLabel = "com.christinesmith.t3-nightly-sync";
const branch = "christine/t3-3669-mac-20261028";
const trailer = "Otis-Task: agenda-task:751f84838c97405894f13c970a219c93";
const controls = [
  "t3-nightly-sync.mjs",
  "t3-nightly-macos.mjs",
  "t3-nightly-resolver.mjs",
  "t3-nightly-macos-host.py",
  "macos-activation-guard.py",
  "macos-active-checkpoint.py",
  "macos-native-idle.mjs",
  "macos-storage.py",
  "macos-rollback-archive.py",
  "macos-peer-handoff.py",
];

export function validateMacConfig(config) {
  if (config.maintenanceMode !== undefined && config.maintenanceMode !== "prepare-only")
    throw Error("Unknown nightly maintenance mode.");
  if (config.repository !== "/Users/christinesmith/Developer/t3code" || config.branch !== branch)
    throw Error("The nightly source must be Christine's single checkout and branch.");
  for (const key of ["artifactRoot", "node", "stagingNode", "vp", "stopRoot"])
    if (!NodePath.isAbsolute(config[key] ?? "")) throw Error(`An absolute ${key} is required.`);
  if (config.stopRoot !== "/Users/christinesmith/Codex_Workroom/task_evidence/otis-control")
    throw Error("The nightly stop controls must use Christine's shared workroom route.");
  if (
    !config.artifactRoot.startsWith("/Users/christinesmith/") ||
    NodePath.normalize(config.artifactRoot) !== config.artifactRoot ||
    config.artifactRoot.startsWith(config.repository + "/")
  )
    throw Error("Nightly artifacts must be outside the checkout and below a private directory.");
  if (
    !Array.isArray(config.focusedTests) ||
    config.focusedTests.length === 0 ||
    config.focusedTests.some(
      (file) => !/^[\w./-]+\.test\.[jt]sx?$/.test(file) || file.includes(".."),
    )
  )
    throw Error("Explicit focused test files are required.");
  if (config.millie?.ssh !== "millie-codex")
    throw Error("The established Millie SSH route is required.");
  for (const [host, user] of [
    ["elora", "christinesmith"],
    ["millie", "millie"],
  ]) {
    const item = config[host];
    if (item?.home !== `/Users/${user}` || !item.environmentId || !item.hostname)
      throw Error(`Verified ${host} host, user and environment identity are required.`);
    for (const key of ["sourceRoot", "baseDir", "node", "nativeSocket", "backupRoot"])
      if (!NodePath.isAbsolute(item[key] ?? ""))
        throw Error(`An absolute ${host}.${key} is required.`);
    if (!Array.isArray(item.listenerAddresses) || !item.listenerAddresses.length)
      throw Error(`The observed ${host} listener addresses are required.`);
  }
  return config;
}

export async function runMacNightly(input, io = {}) {
  const config = validateMacConfig(input);
  const preview = io.preview === true;
  const prepareOnly = config.maintenanceMode === "prepare-only";
  const runId = NodeCrypto.randomUUID();
  const root = io.artifactRoot ?? config.artifactRoot;
  NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (
    NodeFS.lstatSync(root).isSymbolicLink() ||
    NodeFS.statSync(root).uid !== process.getuid() ||
    NodeFS.statSync(root).mode & 0o077
  )
    throw Error("The nightly directory must be private and not a symlink.");
  if (!io.run && process.env.T3_NIGHTLY_LOCKED !== "1")
    throw Error("Start the macOS controller through its OS-owned lock wrapper.");
  const directory = NodePath.join(root, `run-${runId}`);
  NodeFS.mkdirSync(directory, { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(directory, "OWNER"), runId, { mode: 0o600 });
  const ledger = {
    runId,
    directory,
    result: "held",
    liveChanges: [],
    swaps: {},
    startedAt: new Date().toISOString(),
  };
  const saveLedger = () => {
    const path = NodePath.join(directory, "result.json");
    const next = path + ".next";
    const descriptor = NodeFS.openSync(next, "w", 0o600);
    try {
      NodeFS.writeFileSync(descriptor, JSON.stringify(ledger, null, 2));
      NodeFS.fsyncSync(descriptor);
    } finally {
      NodeFS.closeSync(descriptor);
    }
    NodeFS.renameSync(next, path);
    const parent = NodeFS.openSync(directory, "r");
    try {
      NodeFS.fsyncSync(parent);
    } finally {
      NodeFS.closeSync(parent);
    }
  };
  saveLedger();
  const env = {
    ...process.env,
    PATH: `${NodePath.dirname(config.node)}:${NodePath.dirname(config.vp)}:${process.env.PATH}`,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "never",
    VITE_OTIS_ENABLED: "false",
    VITE_OTIS_CALL_ENABLED: "false",
  };
  const execute = (exe, args, cwd = config.repository, extraEnv = {}) => {
    const commandEnv = { ...env, ...extraEnv };
    if (io.run) return io.run(exe, args, cwd, commandEnv);
    const result = NodeChildProcess.spawnSync(exe, args, {
      cwd,
      env: commandEnv,
      encoding: "utf8",
      timeout: 7_200_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    NodeFS.appendFileSync(
      NodePath.join(directory, "commands.log"),
      `${JSON.stringify({ exe, args, code: result.status })}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`,
      { mode: 0o600 },
    );
    return { code: result.status ?? 1, text: result.stdout?.trim() ?? "" };
  };
  const stopped = () =>
    ["STOP-ALL", "STOP-t3-nightly-sync"].some((name) =>
      NodeFS.existsSync(NodePath.join(io.stopRoot ?? config.stopRoot, name)),
    );
  const run = (exe, args, cwd, extraEnv) => {
    if (stopped()) throw Error("The nightly update is stopped.");
    const result = execute(exe, args, cwd, extraEnv);
    if (result.code !== 0) throw Error(`The ${NodePath.basename(exe)} step did not pass.`);
    return result.text;
  };
  const git = (...args) => run("git", args);
  const ssh = (command) =>
    run("/usr/bin/ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      config.millie.ssh,
      command,
    ]);
  const quote = (text) => "'" + String(text).replaceAll("'", "'\\''") + "'";
  const hostConfig = NodePath.join(directory, "config.json");
  NodeFS.writeFileSync(hostConfig, JSON.stringify(config), { mode: 0o600 });
  const helper = NodePath.join(import.meta.dirname, "t3-nightly-macos-host.py");
  const remote = `${config.millie.home}/.local/share/t3-nightly/run-${runId}`;
  const host = (name, operation, ...args) =>
    name === "elora"
      ? run("/usr/bin/python3", [helper, hostConfig, name, operation, directory, ...args])
      : ssh(
          [
            "/usr/bin/python3",
            `${remote}/control/t3-nightly-macos-host.py`,
            `${remote}/config.json`,
            name,
            operation,
            remote,
            ...args,
          ]
            .map(quote)
            .join(" "),
        );
  const transferControls = () => {
    const local = NodePath.join(directory, "control");
    if (!io.run) {
      NodeFS.mkdirSync(local, { mode: 0o700, recursive: true });
      for (const file of controls)
        NodeFS.copyFileSync(
          NodePath.join(config.repository, "scripts", file),
          NodePath.join(local, file),
        );
      run(NodePath.join(config.repository, "scripts/node_modules/.bin/esbuild"), [
        NodePath.join(config.repository, "scripts/deploy-macos-backend.ts"),
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node24",
        `--outfile=${NodePath.join(local, "deploy-macos-backend.mjs")}`,
      ]);
      const pnpm = NodePath.join(config.repository, "node_modules/.pnpm");
      const websocket = NodeFS.readdirSync(pnpm).filter((file) => file.startsWith("ws@8."));
      if (websocket.length !== 1)
        throw Error("The native read-only websocket dependency is ambiguous.");
      const target = NodePath.join(local, "node_modules/ws");
      if (NodeFS.existsSync(target)) NodeFS.rmSync(target, { recursive: true });
      NodeFS.cpSync(NodePath.join(pnpm, websocket[0], "node_modules/ws"), target, {
        recursive: true,
      });
    }
    run("/usr/bin/rsync", [
      "-a",
      "-e",
      "ssh -o BatchMode=yes -o ConnectTimeout=15",
      "--",
      local + "/",
      `${config.millie.ssh}:${remote}/control/`,
    ]);
  };
  const captureHosts = () => {
    const admission = Object.fromEntries(
      ["elora", "millie"].map((name) => {
        const text = host(name, "capture");
        const proof = JSON.parse(text);
        if (proof?.admitted !== true) throw Error("Active-work admission proof is incomplete.");
        return [name, proof];
      }),
    );
    ledger.admission = admission;
    saveLedger();
    return admission;
  };
  let base;
  let mergeOwned = false;
  let committed;
  let upstream;
  let deploymentAttempted = false;
  let resolverMayBeRunning = false;
  const history = (line) => {
    if (ledger.historyRecorded !== undefined) return;
    ledger.historyRecorded =
      execute("/usr/bin/python3", [helper, hostConfig, "elora", "note", directory, line]).code ===
      0;
  };
  try {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone launchd operator must verify the real host before invoking guarded deployment.
    const platform = process.platform;
    if (!io.run && (platform !== "darwin" || NodeOS.userInfo().username !== "christinesmith"))
      throw Error("The nightly controller only runs as Christine on Elora.");
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "America/New_York")
      throw Error("Elora's calendar timezone must be America/New_York.");
    if (
      git("rev-parse", "--show-toplevel") !== config.repository ||
      git("branch", "--show-current") !== branch ||
      git("status", "--porcelain", "--untracked-files=normal")
    )
      throw Error("The source checkout is not clean and on its expected branch.");
    for (const [remoteName, expected] of [
      ["origin", "https://github.com/coolnether123/t3code"],
      ["upstream", "https://github.com/pingdotgg/t3code"],
    ])
      if (git("remote", "get-url", remoteName).replace(/\.git$/, "") !== expected)
        throw Error("A source remote changed.");
    if (
      git("remote", "get-url", "nas") !==
      "millie-codex:/Volumes/Photos/Otis_Git_Backups/elora-t3code.git"
    )
      throw Error("The established source backup remote changed.");
    base = git("rev-parse", "HEAD");
    ledger.base = base;
    ssh(["mkdir", "-m", "700", "-p", remote].map(quote).join(" "));
    ssh(["mkdir", "-m", "700", remote + "/control"].map(quote).join(" "));
    transferControls();
    run("/usr/bin/scp", [
      "-q",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "--",
      hostConfig,
      `${config.millie.ssh}:${remote}/config.json`,
    ]);
    if (!prepareOnly || preview) captureHosts();
    if (preview) {
      ledger.result = "previewed";
      return ledger;
    }
    const installed = prepareOnly
      ? {}
      : Object.fromEntries(
          ["elora", "millie"].map((name) => {
            const value = JSON.parse(host(name, "installed"));
            if (!/^[0-9a-f]{12,40}$/.test(value.commitPrefix ?? ""))
              throw Error("An installed source identity is uncertain.");
            return [name, value.commitPrefix];
          }),
        );
    if (!prepareOnly) {
      host("elora", "maintenance");
      host("millie", "maintenance");
    }
    git("fetch", "origin");
    git("fetch", "upstream");
    upstream = git("rev-parse", "refs/remotes/upstream/main");
    const integrated = execute("git", ["merge-base", "--is-ancestor", upstream, base]).code === 0;
    if (
      !prepareOnly &&
      integrated &&
      Object.values(installed).every((prefix) => base.startsWith(prefix))
    ) {
      ledger.result = "already-current";
      return ledger;
    }
    git("push", "--dry-run", "nas", `HEAD:refs/heads/${branch}`);
    if (!integrated) {
      if (
        git("rev-parse", "HEAD") !== base ||
        git("status", "--porcelain", "--untracked-files=normal")
      )
        throw Error("The checkout changed before the owned merge.");
      mergeOwned = true;
      if (stopped()) throw Error("The nightly update is stopped.");
      const merge = execute("git", ["merge", "--no-ff", "--no-commit", upstream]);
      if (merge.code !== 0) {
        const conflicts = git("diff", "--name-only", "--diff-filter=U", "-z")
          .split("\0")
          .filter(Boolean);
        if (
          !conflicts.length ||
          git("rev-parse", "MERGE_HEAD") !== upstream ||
          git("rev-parse", "HEAD") !== base
        )
          throw Error("The owned merge failed without verified conflicts.");
        captureHosts();
        resolverMayBeRunning = true;
        ledger.resolver = await resolveNightlyConflict(
          {
            config,
            root,
            directory,
            upstream,
            base,
            conflicts,
            env,
          },
          { run: io.run ? execute : undefined, launch: io.launchResolver },
        );
        resolverMayBeRunning = !ledger.resolver.safeToRecover;
        if (ledger.resolver.status !== "resolved")
          throw Error(
            "The one-shot conflict resolver did not complete; its per-head claim is retained.",
          );
        if (
          git("rev-parse", "HEAD") !== base ||
          git("branch", "--show-current") !== branch ||
          git("rev-parse", "MERGE_HEAD") !== upstream ||
          git("ls-files", "--others", "--exclude-standard")
        )
          throw Error("The conflict resolver changed source ownership or left untracked files.");
        git("add", "--update");
        if (git("diff", "--name-only", "--diff-filter=U") || git("diff", "--name-only"))
          throw Error("The conflict resolver left unresolved or unstaged changes.");
      }
    }
    run(config.vp, ["install", "--frozen-lockfile"]);
    run(config.vp, ["run", "typecheck"]);
    run(config.vp, ["check"]);
    run(config.vp, ["test", "run", ...config.focusedTests]);
    run(config.node, [
      "--test",
      NodePath.join(config.repository, "scripts/t3-nightly-macos.fixture.mjs"),
      NodePath.join(config.repository, "scripts/t3-nightly-resolver.fixture.mjs"),
    ]);
    run("/usr/bin/python3", [
      NodePath.join(config.repository, "scripts/test_macos_activation_guard.py"),
    ]);
    run("/usr/bin/python3", [NodePath.join(config.repository, "scripts/test_t3_nightly_macos.py")]);
    run(config.vp, ["run", "check:changed", base]);
    if (git("diff", "--name-only") || git("ls-files", "--others", "--exclude-standard"))
      throw Error("A gate modified source files; the nightly merge was not accepted.");
    if (!prepareOnly) captureHosts();
    if (git("rev-parse", "HEAD") !== base || git("branch", "--show-current") !== branch)
      throw Error("The checkout advanced during the nightly gates.");
    if (mergeOwned)
      git("commit", "-m", `chore(sync): integrate upstream main on macOS\n\n${trailer}`);
    mergeOwned = false;
    committed = git("rev-parse", "HEAD");
    ledger.commit = committed;
    transferControls();
    run("/bin/bash", [
      NodePath.join(config.repository, "scripts/launch-t3-code-macos.sh"),
      "--build-only",
      "--expected-branch",
      branch,
      "--expected-commit",
      committed,
      "--backup-root",
      NodePath.join(root, "build-logs"),
      "--artifact-dir",
      NodePath.join(directory, "artifact"),
    ]);
    if (io.stage) await io.stage(directory, committed);
    else {
      const apps = NodeFS.readdirSync(NodePath.join(directory, "artifact/extracted")).filter(
        (file) => file.endsWith(".app"),
      );
      if (apps.length !== 1) throw Error("The staged desktop app is uncertain.");
      ledger.app = NodePath.join(directory, "artifact/extracted", apps[0]);
      const candidate = NodePath.join(directory, "candidate");
      run(config.stagingNode, [
        NodePath.join(config.repository, "scripts/stage-macos-backend.ts"),
        "--source-root",
        config.repository,
        "--output",
        candidate,
        "--commit",
        committed,
        "--arch",
        "arm64",
      ]);
      run("/usr/bin/rsync", [
        "-a",
        "-e",
        "ssh -o BatchMode=yes -o ConnectTimeout=15",
        "--",
        candidate,
        `${config.millie.ssh}:${remote}/`,
      ]);
      if (!prepareOnly) host("millie", "prepare", committed);
    }
    if (!prepareOnly) captureHosts();
    git("push", "nas", `HEAD:refs/heads/${branch}`);
    if (stopped()) throw Error("The nightly update is stopped.");
    ledger.originPublished =
      execute("git", ["push", "origin", `HEAD:refs/heads/${branch}`]).code === 0;
    if (prepareOnly) {
      if (!io.stage) {
        const inventory = (root) => {
          const files = {};
          const walk = (directory, prefix = "") => {
            for (const name of NodeFS.readdirSync(directory).sort()) {
              const path = NodePath.join(directory, name);
              const key = prefix + name;
              const info = NodeFS.lstatSync(path);
              if (info.isSymbolicLink()) {
                const target = NodeFS.readlinkSync(path);
                const resolved = NodePath.resolve(NodePath.dirname(path), target);
                if (!resolved.startsWith(NodePath.resolve(root) + NodePath.sep))
                  throw Error("Staged artifact symlink escapes its root.");
                files[key] = "link:" + target;
              } else if (info.isDirectory()) walk(path, key + "/");
              else if (info.isFile())
                files[key] = NodeCrypto.createHash("sha256")
                  .update(NodeFS.readFileSync(path))
                  .digest("hex");
              else throw Error("Unsupported staged artifact entry.");
            }
          };
          walk(root);
          return files;
        };
        const common = {
          version: 1,
          commit: committed,
          preparedAt: ledger.startedAt,
          configSha256: NodeCrypto.createHash("sha256")
            .update(NodeFS.readFileSync(hostConfig))
            .digest("hex"),
          controls: inventory(NodePath.join(directory, "control")),
          candidate: inventory(NodePath.join(directory, "candidate")),
        };
        const local = {
          ...common,
          host: "elora",
          runDirectory: directory,
          app: ledger.app,
          appFiles: inventory(ledger.app),
        };
        const peer = { ...common, host: "millie", runDirectory: remote };
        NodeFS.writeFileSync(NodePath.join(directory, "staged.json"), JSON.stringify(local), {
          mode: 0o600,
        });
        const peerManifest = NodePath.join(directory, "staged-millie.json");
        NodeFS.writeFileSync(peerManifest, JSON.stringify(peer), { mode: 0o600 });
        run("/usr/bin/scp", [
          "-q",
          "-o",
          "BatchMode=yes",
          "--",
          peerManifest,
          `${config.millie.ssh}:${remote}/staged.json`,
        ]);
      }
      ledger.result = "prepared";
      return ledger;
    }
    captureHosts();
    ledger.retirementHolds = [];
    for (const name of ["elora", "millie"]) {
      if (committed.startsWith(installed[name])) continue;
      captureHosts();
      deploymentAttempted = true;
      ledger.swaps[name] = { phase: "attempting", commit: committed };
      saveLedger();
      let accepted = JSON.parse(
        host(name, "deploy", committed, ...(name === "elora" ? [ledger.app ?? "fixture-app"] : [])),
      );
      if (name === "millie" && accepted.peerRecoveryRequired === true) {
        host("elora", "capture");
        run("/usr/bin/python3", [
          NodePath.join(config.repository, "scripts/macos-peer-handoff.py"),
          "coordinate",
          hostConfig,
          directory,
          remote,
          committed,
        ]);
        accepted = JSON.parse(host("millie", "accept-recovered", committed));
        ledger.peerHandoff = true;
      }
      if (!committed.startsWith(accepted.commitPrefix ?? "!"))
        throw Error("A deployment receipt is uncertain.");
      if (accepted.recovery?.verified !== true)
        throw Error("The installed source lacks verified active-work recovery.");
      ledger.liveChanges.push(name);
      ledger.swaps[name] = { phase: "accepted", commit: committed, recovery: accepted.recovery };
      saveLedger();
      if (accepted.maintenanceHold) ledger.retirementHolds.push(name);
    }
    ledger.result = "deployed";
    try {
      host("millie", "cleanup");
    } catch {
      ledger.cleanupHeld = true;
    }
    if (
      ledger.resolver ||
      !ledger.originPublished ||
      ledger.retirementHolds.length ||
      ledger.cleanupHeld
    )
      history(
        ledger.retirementHolds.length || ledger.cleanupHeld
          ? "T3's nightly update installed. Older rollback copies are retained because local archiving did not finish; GitHub publication is recorded separately."
          : ledger.originPublished
            ? "T3's nightly update repaired its merge conflicts, passed its checks and installed on both Macs."
            : "T3's nightly update installed on both Macs and was backed up. Publishing to GitHub still needs the repository owner's access.",
      );
    return ledger;
  } catch (error) {
    ledger.reason = error.message;
    if (
      !resolverMayBeRunning &&
      mergeOwned &&
      execute("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).text === upstream &&
      execute("git", ["rev-parse", "HEAD"]).text === base
    )
      execute("git", ["merge", "--abort"]);
    else if (
      !resolverMayBeRunning &&
      committed &&
      !deploymentAttempted &&
      ledger.liveChanges.length === 0 &&
      execute("git", ["rev-parse", "HEAD"]).text === committed &&
      execute("git", ["status", "--porcelain", "--untracked-files=normal"]).text === ""
    )
      execute("git", ["reset", "--merge", base]);
    if (
      base &&
      ledger.liveChanges.length === 0 &&
      (execute("git", ["rev-parse", "HEAD"]).text !== base ||
        execute("git", ["status", "--porcelain", "--untracked-files=normal"]).text !== "" ||
        execute("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0)
    )
      ledger.sourceRecoveryRequired = true;
    const line = deploymentAttempted
      ? "T3's nightly install did not finish. A Mac may have changed; its saved rollback and exact install records are retained for recovery."
      : "T3's nightly update did not pass its checks. The installed apps were left alone.";
    // Failure history is one text-only request, never a speech or messaging route.
    if (!preview) history(line);
    return ledger;
  } finally {
    ledger.finishedAt = new Date().toISOString();
    saveLedger();
    if (
      ledger.result !== "prepared" &&
      (!deploymentAttempted || ledger.result === "deployed") &&
      NodeFS.readFileSync(NodePath.join(directory, "OWNER"), "utf8") === runId
    ) {
      for (const name of ["artifact", "unpacked", "candidate", "control"])
        if (NodeFS.existsSync(NodePath.join(directory, name)))
          NodeFS.rmSync(NodePath.join(directory, name), { recursive: true });
    }
  }
}
