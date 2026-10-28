import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeTimersPromises from "node:timers/promises";
import { ReleaseTransaction, readReleaseState } from "./t3-release-state.mjs";

export const supervisorPipe = (root, mode) =>
  `\\\\.\\pipe\\t3-supervisor-${NodeCrypto.createHash("sha256").update(NodePath.resolve(root).toLowerCase()).digest("hex")}-${mode}`;
export async function supervisorCommand(config, mode, command, release) {
  const socket = NodeNet.connect(supervisorPipe(config.releaseRoot, mode));
  socket.setTimeout(30000, () => socket.destroy(new Error("Supervisor acknowledgement timed out")));
  try {
    await NodeEvents.once(socket, "connect");
  } catch (error) {
    socket.destroy();
    throw new Error(
      `Supervisor ${mode} pipe ${socket.remoteAddress ?? supervisorPipe(config.releaseRoot, mode)}: ${error.code ?? error.message}. EPERM means pipe access was denied; ENOENT means the owner is not listening.`,
      { cause: error },
    );
  }
  socket.write(JSON.stringify({ command, release }) + "\n");
  let data = "";
  for await (const chunk of socket) data += chunk;
  const result = JSON.parse(data);
  if (result.error) throw new Error(result.error);
  return result;
}

export const shouldRestartChild = (paused, child) =>
  !paused && (!child || child.exitCode !== null || child.signalCode !== null);

export async function recoverStartup(config, recover, start, waitForLock = true) {
  try {
    await recover();
  } catch (error) {
    // An active restore owns the same lock; do not start against its partial snapshot.
    for (;;) {
      try {
        await new ReleaseTransaction(config.releaseRoot, {}).exclusive(async () => {
          const state = readReleaseState(config.releaseRoot);
          const receipt = {
            ok: false,
            failure: String(error),
            pending: state.pending,
            current: state.current,
            at: new Date().toISOString(),
            fallback: "start-current",
          };
          try {
            await start(state.current);
          } catch (failure) {
            receipt.fallbackFailure = String(failure);
          }
          NodeFS.writeFileSync(
            NodePath.join(config.releaseRoot, "last-recovery.json"),
            JSON.stringify(receipt, null, 2),
          );
        });
        return true;
      } catch (failure) {
        if (failure.code !== "EADDRINUSE") throw failure;
        if (!waitForLock) return false;
        await NodeTimersPromises.setTimeout(1000);
      }
    }
  }
}

async function supervise(configFile, mode) {
  if (!["server", "web"].includes(mode)) throw new Error("Invalid supervisor mode");
  const config = JSON.parse(NodeFS.readFileSync(configFile, "utf8"));
  let child;
  let paused = true;
  let release;
  let startedAt;
  let ready = false;
  let startupDeadline = 0;
  let lastProbe = 0;
  let failedChecks = 0;
  let serial = Promise.resolve();
  const stop = async () => {
    paused = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = NodeEvents.once(child, "exit");
      // Only the child captured by this owner is a termination target.
      const killer = NodeChildProcess.spawn(
        "C:/Windows/System32/taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      const [code] = await NodeEvents.once(killer, "exit");
      if (code !== 0 && child.exitCode === null && child.signalCode === null)
        throw new Error("Captured child could not be stopped");
      const deadline = new AbortController();
      try {
        await Promise.race([
          exited,
          NodeTimersPromises.setTimeout(15000, undefined, { signal: deadline.signal }).then(() => {
            throw new Error("Captured child did not acknowledge exit");
          }),
        ]);
      } finally {
        deadline.abort();
      }
    }
    child = undefined;
  };
  const launch = async (selected) => {
    await stop();
    release = selected;
    const root = NodePath.resolve(release);
    const args =
      config.fixtureLaunch?.[mode]?.args ??
      (mode === "server"
        ? [
            NodePath.join(root, "apps/server/dist/bin.mjs"),
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "3774",
            "--base-dir",
            config.baseDir,
            "--no-browser",
          ]
        : [
            NodePath.join(root, "node_modules/vite-plus/bin/vp"),
            "dev",
            "--host",
            "127.0.0.1",
            "--port",
            "6803",
          ]);
    const logs = NodePath.join(config.releaseRoot, "supervisor-logs");
    NodeFS.mkdirSync(logs, { recursive: true });
    const log = NodeFS.openSync(NodePath.join(logs, `${mode}.log`), "a");
    try {
      child = NodeChildProcess.spawn(config.node, args, {
        cwd: config.fixtureLaunch
          ? root
          : mode === "server"
            ? root
            : NodePath.join(root, "apps/web"),
        windowsHide: true,
        stdio: ["ignore", log, log],
        env: {
          ...process.env,
          PATH: `${NodePath.dirname(config.node)};${process.env.PATH}`,
          T3CODE_HOME: config.baseDir,
          ...(mode === "web"
            ? {
                T3CODE_PORT_OFFSET: "1070",
                T3CODE_PORT: "3774",
                PORT: "6803",
                T3CODE_SINGLE_ORIGIN_DEV: "1",
              }
            : {}),
        },
      });
    } finally {
      NodeFS.closeSync(log);
    }
    await NodeEvents.once(child, "spawn");
    startedAt = new Date().toISOString();
    ready = false;
    startupDeadline = Date.now() + 300000;
    lastProbe = 0;
    failedChecks = 0;
    paused = false;
  };
  const start = async (selected) => {
    try {
      await launch(selected);
    } finally {
      paused = false;
    }
  };
  const status = () => ({
    supervisorPid: process.pid,
    script: import.meta.filename,
    pid: child?.exitCode === null && child.signalCode === null ? child.pid : null,
    startedAt,
    release,
    paused,
    mode,
  });
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.endsWith("\n")) return;
      socket.pause();
      serial = serial
        .then(async () => {
          const request = JSON.parse(data);
          if (request.command === "stop") await stop();
          else if (request.command === "start") {
            const state = readReleaseState(config.releaseRoot);
            const allowed = [
              state.current,
              ...state.good,
              state.pending?.candidate,
              state.pending?.previous,
            ].filter(Boolean);
            if (
              !allowed.some((path) => NodePath.resolve(path) === NodePath.resolve(request.release))
            )
              throw new Error("Release is absent from the deployment journal");
            await start(request.release);
          } else if (request.command !== "status") throw new Error("Unknown supervisor command");
          socket.end(JSON.stringify(status()));
        })
        .catch(() => socket.end(JSON.stringify({ error: "Supervisor operation failed" })));
    });
  });
  // Node exposes world read/write pipe flags, but no per-SID DACL option.
  server.listen({
    path: supervisorPipe(config.releaseRoot, mode),
    readableAll: true,
    writableAll: true,
  });
  await NodeEvents.once(server, "listening");
  const state = readReleaseState(config.releaseRoot);
  if (state.pending && mode === "server") {
    await recoverStartup(
      config,
      async () => {
        const recovery = NodeChildProcess.spawn(
          config.node,
          [NodePath.join(import.meta.dirname, "t3-deploy.mjs"), "recover", configFile],
          { windowsHide: true, stdio: "ignore" },
        );
        const [code] = await NodeEvents.once(recovery, "exit");
        if (code !== 0) throw new Error(`Recovery failed with exit ${code}`);
        if (!child || child.exitCode !== null)
          await start(readReleaseState(config.releaseRoot).current);
      },
      start,
    );
  } else if (!state.pending) await start(state.current);
  else {
    // The web owner stays available to recovery commands while awaiting the server result.
    const recoveryDeadline = Date.now() + 600000;
    const timer = setInterval(() => {
      serial = serial
        .then(async () => {
          const latest = readReleaseState(config.releaseRoot);
          const file = NodePath.join(config.releaseRoot, "last-recovery.json");
          const receipt = NodeFS.existsSync(file)
            ? JSON.parse(NodeFS.readFileSync(file, "utf8"))
            : null;
          if (latest.pending && Date.now() >= recoveryDeadline) {
            const recovered = await recoverStartup(
              config,
              async () => {
                throw new Error("Server recovery owner did not finish within ten minutes");
              },
              start,
              false,
            );
            if (recovered) clearInterval(timer);
            return;
          }
          if (
            !latest.pending ||
            (receipt?.ok === false && receipt.pending?.id === latest.pending.id)
          ) {
            clearInterval(timer);
            if (!child || child.exitCode !== null) await start(latest.current);
          }
        })
        .catch(() => {});
    }, 1000);
  }
  process.send?.("ready");
  setInterval(() => {
    serial = serial
      .then(async () => {
        const state = readReleaseState(config.releaseRoot);
        // Offline snapshots and rollback deliberately keep both owners paused.
        if (paused) return;
        if (shouldRestartChild(paused, child)) {
          await start(state.current);
          return;
        }
        if (config.fixtureLaunch || Date.now() - lastProbe < 15000) return;
        lastProbe = Date.now();
        const url = config.healthUrls[mode === "server" ? 0 : 1];
        const healthy = await fetch(url, { signal: AbortSignal.timeout(8000) }).then(
          (response) => response.status === 200,
          () => false,
        );
        if (healthy) {
          ready = true;
          failedChecks = 0;
          return;
        }
        if (!ready && Date.now() < startupDeadline) return;
        failedChecks++;
        if (!ready || failedChecks >= 6) await start(state.current);
      })
      .catch(() => {});
  }, 5000);
}
if (process.argv[1] === import.meta.filename) await supervise(process.argv[2], process.argv[3]);
