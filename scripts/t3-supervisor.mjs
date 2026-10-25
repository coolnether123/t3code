import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeTimersPromises from "node:timers/promises";
import { readReleaseState } from "./t3-release-state.mjs";

export const supervisorPipe = (root, mode) =>
  `\\\\.\\pipe\\t3-supervisor-${NodeCrypto.createHash("sha256").update(NodePath.resolve(root).toLowerCase()).digest("hex")}-${mode}`;
export async function supervisorCommand(config, mode, command, release) {
  const socket = NodeNet.connect(supervisorPipe(config.releaseRoot, mode));
  socket.setTimeout(30000, () => socket.destroy(new Error("Supervisor acknowledgement timed out")));
  await NodeEvents.once(socket, "connect");
  socket.write(JSON.stringify({ command, release }) + "\n");
  let data = "";
  for await (const chunk of socket) data += chunk;
  const result = JSON.parse(data);
  if (result.error) throw new Error(result.error);
  return result;
}

async function supervise(configFile, mode) {
  if (!["server", "web"].includes(mode)) throw new Error("Invalid supervisor mode");
  const config = JSON.parse(NodeFS.readFileSync(configFile, "utf8"));
  let child;
  let paused = true;
  let release;
  let startedAt;
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
  const start = async (selected) => {
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
    child = NodeChildProcess.spawn(config.node, args, {
      cwd: config.fixtureLaunch ? root : mode === "server" ? root : NodePath.join(root, "apps/web"),
      windowsHide: true,
      stdio: "ignore",
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
    await NodeEvents.once(child, "spawn");
    startedAt = new Date().toISOString();
    paused = false;
  };
  const status = () => ({
    supervisorPid: process.pid,
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
          else if (request.command === "start") await start(request.release);
          else if (request.command !== "status") throw new Error("Unknown supervisor command");
          socket.end(JSON.stringify(status()));
        })
        .catch(() => socket.end(JSON.stringify({ error: "Supervisor operation failed" })));
    });
  });
  server.listen(supervisorPipe(config.releaseRoot, mode));
  await NodeEvents.once(server, "listening");
  const state = readReleaseState(config.releaseRoot);
  if (state.pending && mode === "server") {
    const recovery = NodeChildProcess.spawn(
      config.node,
      [NodePath.join(import.meta.dirname, "t3-deploy.mjs"), "recover", configFile],
      { windowsHide: true, stdio: "ignore" },
    );
    const [code] = await NodeEvents.once(recovery, "exit");
    if (code !== 0) throw new Error("Recovery failed; owners remain paused");
  } else if (!state.pending) await start(state.current);
  process.send?.("ready");
  setInterval(() => {
    serial = serial
      .then(async () => {
        if (
          !paused &&
          (child?.exitCode !== null || child?.signalCode !== null) &&
          !readReleaseState(config.releaseRoot).pending
        )
          await start(readReleaseState(config.releaseRoot).current);
      })
      .catch(() => {});
  }, 5000);
}
if (process.argv[1] === import.meta.filename) await supervise(process.argv[2], process.argv[3]);
