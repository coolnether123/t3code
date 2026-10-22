import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("./node_modules/ws");
const known = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "business",
  "enterprise",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
]);
const pending = new Set();
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "planType" && typeof item === "string" && !known.has(item)
          ? "unknown"
          : normalize(item),
      ]),
    );
  return value;
}
function translate(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return data;
  }
  const reply = pending.has(message?.id) && ("result" in message || "error" in message);
  if (reply) pending.delete(message.id);
  return reply || ["account/updated", "account/rateLimits/updated"].includes(message?.method)
    ? JSON.stringify(normalize(message))
    : data;
}
function transport(input, output) {
  const stream = new Duplex({
    read() {
      input.resume();
    },
    write(chunk, _encoding, callback) {
      output.write(chunk, callback);
    },
  });
  stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = () => stream;
  input.on("data", (chunk) => {
    if (!stream.push(chunk)) input.pause();
  });
  input.on("end", () => stream.push(null));
  input.on("error", () => stream.destroy());
  stream.on("error", () => {});
  return stream;
}
const child = spawn(join(homedir(), ".local/bin/codex"), process.argv.slice(2), {
  stdio: ["pipe", "pipe", "inherit"],
});
let client;
let stopping = false;
let waitingPong = false;
let heartbeat;
const stop = (failed = false) => {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  if (failed) {
    console.error("T3 Codex compatibility transport closed");
    process.exitCode = 1;
  }
  client?.terminate();
  remote.terminate();
  if (child.exitCode === null) child.kill("SIGTERM");
  process.stdin.pause();
};
const remote = new WebSocket("ws://localhost/", {
  createConnection: () => transport(child.stdout, child.stdin),
  perMessageDeflate: false,
  handshakeTimeout: 10000,
  maxPayload: 64 * 1024 * 1024,
});
const awaitingClient = [];
const awaitingRemote = [];
remote.on("message", (data) => {
  const reply = translate(data);
  if (client?.readyState === WebSocket.OPEN) client.send(reply);
  else awaitingClient.push(reply);
});
remote.on("open", () => {
  for (const message of awaitingRemote.splice(0)) remote.send(message, { binary: false });
  heartbeat = setInterval(() => {
    if (waitingPong) return stop(true);
    waitingPong = true;
    remote.ping();
  }, 30000);
  heartbeat.unref();
});
remote.on("pong", () => {
  waitingPong = false;
});
remote.on("error", () => stop(true));
remote.on("close", () => stop());
const server = createServer();
const socketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 64 * 1024 * 1024,
});
server.on("upgrade", (request, socket, head) =>
  socketServer.handleUpgrade(request, socket, head, (ws) => socketServer.emit("connection", ws)),
);
socketServer.on("connection", (ws) => {
  client = ws;
  for (const message of awaitingClient.splice(0)) ws.send(message);
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (["account/read", "account/rateLimits/read"].includes(message.method))
        pending.add(message.id);
    } catch {}
    if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary: false });
    else awaitingRemote.push(data);
  });
  ws.on("error", () => stop(true));
  ws.on("close", () => stop());
});
child.on("error", () => stop(true));
child.on("exit", (code) => {
  if (code && process.exitCode === undefined) process.exitCode = code;
  stop();
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop());
server.emit("connection", transport(process.stdin, process.stdout));
