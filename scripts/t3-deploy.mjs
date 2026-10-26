import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import { ReleaseTransaction, readReleaseState } from "./t3-release-state.mjs";
import { supervisorCommand } from "./t3-supervisor.mjs";
import { idleEvidence } from "./t3-deploy-idle.mjs";

function run(exe, args, input) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(exe, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`Command failed with exit ${code}`)),
    );
    child.stdin.end(input);
  });
}
const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  const tmp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const fd = NodeFS.openSync(tmp, "wx");
  try {
    NodeFS.writeFileSync(fd, JSON.stringify(value, null, 2));
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(tmp, file);
};
export function retainReleases(root) {
  const state = readReleaseState(root);
  if (state.pending) throw new Error("Retention requires a completed transaction");
  const keep = new Set(
    [state.current, ...state.good].map((p) => NodePath.resolve(p).toLowerCase()),
  );
  const deleted = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{40}$/.test(entry.name)) continue;
    const target = NodePath.join(root, entry.name);
    if (keep.has(NodePath.resolve(target).toLowerCase())) continue;
    if (
      NodeFS.lstatSync(target).isSymbolicLink() ||
      NodePath.dirname(NodeFS.realpathSync(target)).toLowerCase() !==
        NodeFS.realpathSync(root).toLowerCase()
    )
      throw new Error("Retention target escapes release root");
    const receipt = readJson(NodePath.join(target, "release.json"));
    if (receipt.commit !== entry.name) throw new Error("Retention identity mismatch");
    NodeFS.rmSync(target, { recursive: true });
    deleted.push(entry.name);
  }
  return deleted;
}
// Unknown and unsuccessful snapshots are retained for recovery and diagnosis.
export function retainSnapshots(config) {
  const state = readReleaseState(config.releaseRoot);
  if (state.pending) return [];
  const lastFile = NodePath.join(config.releaseRoot, "last-deploy.json");
  if (!NodeFS.existsSync(lastFile)) return [];
  const latest = readJson(lastFile);
  const verifiedAt = Date.parse(latest.finishedAt);
  if (
    latest.result !== "healthy" ||
    latest.candidate !== state.current ||
    !Number.isFinite(verifiedAt)
  )
    return [];
  if (!NodeFS.existsSync(config.backupRoot)) return [];
  const root = NodePath.resolve(config.backupRoot);
  if (
    NodeFS.lstatSync(root).isSymbolicLink() ||
    NodeFS.realpathSync(root).toLowerCase() !== root.toLowerCase()
  )
    throw new Error("Snapshot retention root escapes configured path");
  const keep = new Set(
    [state.current, ...state.good.slice(0, 3)].map((p) => NodePath.resolve(p).toLowerCase()),
  );
  const targets = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = NodePath.join(root, entry.name);
    const receiptFile = NodePath.join(config.releaseRoot, `receipt-${entry.name}.json`);
    if (!NodeFS.existsSync(receiptFile)) continue;
    const receipt = readJson(receiptFile);
    const finishedAt = Date.parse(receipt.finishedAt);
    if (
      receipt.result !== "healthy" ||
      !Number.isFinite(finishedAt) ||
      finishedAt >= verifiedAt ||
      typeof receipt.previous !== "string"
    )
      continue;
    if (keep.has(NodePath.resolve(receipt.previous).toLowerCase())) continue;
    const manifest = readJson(NodePath.join(target, "snapshot.json"));
    if (
      receipt.id !== entry.name ||
      manifest.id !== entry.name ||
      manifest.source !== config.baseDir ||
      manifest.offline !== true
    )
      throw new Error("Snapshot retention identity mismatch");
    if (
      NodeFS.lstatSync(target).isSymbolicLink() ||
      NodePath.dirname(NodeFS.realpathSync(target)).toLowerCase() !== root.toLowerCase()
    )
      throw new Error("Snapshot retention target escapes backup root");
    targets.push(target);
  }
  // Validate the complete deletion set before removing any private snapshot.
  for (const target of targets) NodeFS.rmSync(target, { recursive: true });
  return targets.map((target) => NodePath.basename(target));
}
export function productionAdapter(config, io = {}) {
  let oldRuntime;
  let switchAt;
  let idle;
  const cli =
    io.cli ??
    ((release, request) =>
      run(
        config.node,
        [
          NodePath.join(release, "apps/server/dist/bin.mjs"),
          "agent",
          "request",
          "--base-dir",
          config.baseDir,
        ],
        JSON.stringify(request),
      ).then(JSON.parse));
  const currentCli = (request) => cli(readReleaseState(config.releaseRoot).current, request);
  const owners =
    io.owners ??
    ((command, release) =>
      Promise.all(
        ["server", "web"].map((mode) => supervisorCommand(config, mode, command, release)),
      ));
  const http = io.fetch ?? fetch;
  const until =
    io.observe ??
    (async (operation, seconds = 180) => {
      const end = Date.now() + seconds * 1000;
      let last;
      while (Date.now() < end) {
        try {
          const value = await operation();
          if (value) return value;
        } catch (error) {
          last = error;
        }
        await NodeTimersPromises.setTimeout(1000);
      }
      throw last ?? new Error("Deployment observation timed out");
    });
  const snapshotPages = async () => {
    const pages = [];
    let offset = 0;
    do {
      const page = await currentCli({ kind: "snapshot", offset });
      pages.push(page);
      offset = page.listPage.nextOffset;
    } while (offset !== null);
    return pages;
  };
  return {
    async validate(candidate) {
      const receipt = readJson(NodePath.join(candidate, "release.json"));
      if (
        receipt.commit !== NodePath.basename(candidate) ||
        NodePath.dirname(NodePath.resolve(candidate)) !== NodePath.resolve(config.releaseRoot)
      )
        throw new Error("Candidate identity mismatch");
      for (const file of [
        "apps/server/dist/bin.mjs",
        "apps/server/dist/client/index.html",
        "apps/web/dist/index.html",
      ])
        if (!NodeFS.statSync(NodePath.join(candidate, file)).isFile())
          throw new Error(`Missing ${file}`);
      for (const artifact of receipt.artifacts) {
        const file = NodePath.resolve(candidate, artifact.path);
        if (
          !file.startsWith(NodePath.resolve(candidate) + NodePath.sep) ||
          NodeCrypto.createHash("sha256")
            .update(NodeFS.readFileSync(file))
            .digest("hex")
            .toLowerCase() !== artifact.sha256.toLowerCase()
        )
          throw new Error("Prepared artifact identity changed");
      }
    },
    async waitForIdle() {
      idle = await until(async () => {
        const pages = await snapshotPages();
        const router =
          pages[0].voice === undefined
            ? await http("http://127.0.0.1:8085/health").then((r) => r.json())
            : undefined;
        const evidence = idleEvidence(pages, router);
        return evidence.idle ? evidence : undefined;
      }, config.idleTimeoutSeconds ?? 3600);
      oldRuntime = idle.runtime;
      if (io.recordIdle !== false)
        writeJson(NodePath.join(config.releaseRoot, "last-idle.json"), {
          ...idle,
          observedAt: new Date().toISOString(),
        });
      return idle;
    },
    async stop() {
      switchAt = new Date().toISOString();
      const statuses = await until(
        () => owners("stop"),
        config.supervisorReadyTimeoutSeconds ?? 120,
      );
      if (statuses.some((s) => !s.paused || s.pid !== null))
        throw new Error("Both owners must acknowledge shutdown");
    },
    async backup(id) {
      const root = NodePath.join(config.backupRoot, id);
      NodeFS.mkdirSync(root, { recursive: true });
      NodeFS.cpSync(NodePath.join(config.baseDir, "userdata"), NodePath.join(root, "userdata"), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        filter: (source) => {
          if (NodeFS.lstatSync(source).isSymbolicLink())
            throw new Error("Offline snapshot cannot contain junctions or symlinks");
          return true;
        },
      });
      // WAL and SHM are copied together with every database while both owners are stopped.
      writeJson(NodePath.join(root, "snapshot.json"), {
        id,
        source: config.baseDir,
        offline: true,
      });
      return root;
    },
    async restore(root) {
      const manifest = readJson(NodePath.join(root, "snapshot.json"));
      if (
        manifest.source !== config.baseDir ||
        manifest.offline !== true ||
        manifest.id !== NodePath.basename(root) ||
        NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(config.backupRoot)
      )
        throw new Error("Offline snapshot identity mismatch");
      const data = NodePath.join(config.baseDir, "userdata");
      const failed = `${data}.failed-${NodeCrypto.randomUUID()}`;
      const staged = `${data}.restore-${NodeCrypto.randomUUID()}`;
      NodeFS.cpSync(NodePath.join(root, "userdata"), staged, { recursive: true });
      if (NodeFS.existsSync(data)) NodeFS.renameSync(data, failed);
      NodeFS.renameSync(staged, data);
    },
    async start(release) {
      await owners("start", release);
    },
    async health(release) {
      const observed = await until(async () => {
        const statuses = await owners("status");
        if (
          statuses.some(
            (s) => !s.pid || s.paused || s.release !== release || s.startedAt < switchAt,
          )
        )
          return;
        const checks = await Promise.all(
          config.healthUrls.map(
            async (url) => (await http(url, { signal: AbortSignal.timeout(10000) })).status,
          ),
        );
        if (checks.some((code) => code !== 200)) return;
        const snapshot = await cli(release, { kind: "snapshot" });
        if (snapshot.runtime.pid !== statuses.find((status) => status.mode === "server")?.pid)
          return;
        if (snapshot.runtime.pid === oldRuntime?.pid || snapshot.runtime.startedAt < switchAt)
          return;
        return {
          statuses,
          runtime: snapshot.runtime,
          checks,
          migrations: "authenticated-projection-readable",
        };
      }, 300);
      const threadId = NodeCrypto.randomUUID();
      const nonce = `deploy-proof-${NodeCrypto.randomUUID()}`;
      const act = async (command) => {
        const identity = await cli(release, { kind: "snapshot" });
        return cli(release, {
          kind: "act",
          confirm: true,
          environmentId: identity.environmentId,
          runtime: identity.runtime,
          command: { ...command, commandId: NodeCrypto.randomUUID() },
        });
      };
      await act({
        type: "thread.create",
        threadId,
        projectId: config.projectId,
        title: `Deployment verification ${nonce}`,
        modelSelection: config.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "server",
      });
      try {
        await act({
          type: "message.dispatch",
          threadId,
          messageId: NodeCrypto.randomUUID(),
          text: `Reply with exactly ${nonce}. Do not use tools.`,
          attachments: [],
          modelSelection: config.modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        });
        await until(async () => {
          const detail = await cli(release, { kind: "snapshot", thread: threadId });
          return (
            detail.messages.some(
              (m) => m.role === "assistant" && !m.streaming && m.text.trim() === nonce,
            ) && !detail.runs.some((r) => ["running", "waiting", "starting"].includes(r.status))
          );
        }, 300);
      } finally {
        await act({ type: "thread.archive", threadId });
      }
      return { ok: true, ...observed, solReply: { threadId, archived: true }, idle };
    },
  };
}
async function main() {
  const [operation, configFile, candidate] = process.argv.slice(2);
  const config = readJson(configFile);
  if (config.modelSelection.model !== "gpt-6.1-sol" || config.healthUrls.length !== 3)
    throw new Error("Require Sol proof and all three health surfaces");
  if (
    config.fixtureLaunch ||
    !["3774", "6803", "9445"].every((port) =>
      config.healthUrls.some((url) => new URL(url).port === port),
    )
  )
    throw new Error("Require production health ports 3774, 6803 and 9445");
  const transaction = new ReleaseTransaction(config.releaseRoot, productionAdapter(config));
  const result =
    operation === "idle-preview"
      ? await productionAdapter(
          { ...config, idleTimeoutSeconds: 1 },
          { recordIdle: false },
        ).waitForIdle()
      : operation === "idle"
        ? await productionAdapter(config).waitForIdle()
        : operation === "owners"
          ? await Promise.all(
              ["server", "web"].map(async (mode) => {
                const owner = await supervisorCommand(config, mode, "status");
                if (
                  !owner.pid ||
                  owner.paused ||
                  owner.release !== readReleaseState(config.releaseRoot).current ||
                  NodePath.resolve(owner.script ?? "") !== NodePath.resolve(config.supervisorScript)
                )
                  throw new Error(`Invalid ${mode} owner after re-pin`);
                return owner;
              }),
            )
          : operation === "recover"
            ? await transaction.recover()
            : operation === "deploy"
              ? await transaction.switchTo(candidate)
              : operation === "status"
                ? {
                    state: readReleaseState(config.releaseRoot),
                    lastRecovery: NodeFS.existsSync(
                      NodePath.join(config.releaseRoot, "last-recovery.json"),
                    )
                      ? readJson(NodePath.join(config.releaseRoot, "last-recovery.json"))
                      : null,
                    stuckPending: Boolean(readReleaseState(config.releaseRoot).pending),
                    lastDeploy: NodeFS.existsSync(
                      NodePath.join(config.releaseRoot, "last-deploy.json"),
                    )
                      ? readJson(NodePath.join(config.releaseRoot, "last-deploy.json"))
                      : null,
                  }
                : (() => {
                    throw new Error("Unknown operation");
                  })();
  if (result.result === "healthy") {
    result.deletedReleases = retainReleases(config.releaseRoot);
    result.deletedSnapshots = retainSnapshots(config);
  }
  console.log(JSON.stringify(result));
  if (result.ok === false || (result.result && result.result !== "healthy")) process.exitCode = 1;
}
if (process.argv[1] === import.meta.filename) await main();
