import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import { ReleaseTransaction, readReleaseState } from "./t3-release-state.mjs";
import { supervisorCommand } from "./t3-supervisor.mjs";
import { restoreOfflineUserdata } from "./t3-restore-userdata.mjs";
import { idleEvidence } from "./t3-deploy-idle.mjs";
import { retainDeployment } from "./t3-release-retention.mjs";

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
  const liveUserdata = () => NodeFS.realpathSync(NodePath.join(config.baseDir, "userdata"));
  return {
    retain(state, options, save, recordPlan) {
      return retainDeployment(
        config,
        state,
        options,
        async (current) => {
          const statuses = await owners("status");
          if (
            statuses.length !== 2 ||
            !["server", "web"].every((mode) =>
              statuses.some(
                (status) =>
                  status.mode === mode &&
                  status.pid &&
                  !status.paused &&
                  typeof status.release === "string" &&
                  NodePath.resolve(status.release).toLowerCase() ===
                    NodePath.resolve(current).toLowerCase(),
              ),
            )
          )
            throw new Error("Both supervisors must be serving the current release for retention");
        },
        save,
        recordPlan,
      );
    },
    async validate(candidate) {
      if (io.expectedCurrent) {
        const state = readReleaseState(config.releaseRoot);
        if (NodePath.basename(state.current) !== io.expectedCurrent)
          throw new Error("The live Windows release advanced during nightly preparation");
        const statuses = await owners("status");
        if (
          statuses.some(
            (status) => !status.pid || status.paused || status.release !== state.current,
          )
        )
          throw new Error("Windows supervisors do not agree with the live release");
      }
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
      const readIdle = async () => {
        const pages = await snapshotPages();
        const router =
          pages[0].voice === undefined
            ? await http("http://127.0.0.1:8085/health").then((r) => r.json())
            : undefined;
        const evidence = idleEvidence(pages, router);
        return evidence.idle ? evidence : undefined;
      };
      idle = io.checkIdleOnce
        ? await readIdle()
        : await until(readIdle, config.idleTimeoutSeconds ?? 3600);
      if (!idle) throw new Error("Nightly deployment requires zero active turns and calls");
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
      // The live userdata may itself be a junction to another volume; only nested links are refused.
      NodeFS.cpSync(liveUserdata(), NodePath.join(root, "userdata"), {
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
      restoreOfflineUserdata(NodePath.join(root, "userdata"), liveUserdata(), io.renameUserdata);
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
          config.healthUrls.map(async (url) => {
            try {
              return (await http(url, { signal: AbortSignal.timeout(10000) })).status;
            } catch (cause) {
              throw new Error(`Health request failed: ${url}`, { cause });
            }
          }),
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
      if (io.passiveHealth) return { ok: true, ...observed, idle };
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
  const [operation, configFile, candidate, proofModel] = process.argv.slice(2);
  const config = readJson(configFile);
  if (operation === "retain") {
    if (proofModel !== undefined && proofModel !== "--dry-run")
      throw new Error("Unknown retention option");
    const transaction = new ReleaseTransaction(config.releaseRoot, productionAdapter(config));
    const result = await transaction.retain({
      retireRelease: candidate === "-" ? undefined : candidate,
      dryRun: proofModel === "--dry-run",
    });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  config.modelSelection = {
    ...config.modelSelection,
    model: operation === "nightly" ? "gpt-6.2-sol" : (proofModel ?? "gpt-6.2-sol"),
    options: [{ id: "effort", value: "low" }],
  };
  const nightly = operation === "nightly";
  if ((!nightly && config.modelSelection.model !== "gpt-6.2-sol") || config.healthUrls.length !== 3)
    throw new Error("Require all three health surfaces and Sol proof for manual deployment");
  if (
    config.fixtureLaunch ||
    !["3774", "6803", "9445"].every((port) =>
      config.healthUrls.some((url) => new URL(url).port === port),
    )
  )
    throw new Error("Require production health ports 3774, 6803 and 9445");
  if (nightly && !/^[a-f0-9]{40}$/.test(proofModel ?? ""))
    throw new Error("Nightly deployment requires the expected live commit");
  const transaction = new ReleaseTransaction(
    config.releaseRoot,
    productionAdapter(
      config,
      nightly
        ? {
            expectedCurrent: proofModel,
            checkIdleOnce: true,
            passiveHealth: true,
          }
        : {},
    ),
  );
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
            : operation === "deploy" || nightly
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
  console.log(JSON.stringify(result));
  if (result.ok === false || (result.result && result.result !== "healthy")) process.exitCode = 1;
}
if (process.argv[1] === import.meta.filename) await main();
