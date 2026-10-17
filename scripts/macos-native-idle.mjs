// Only native read methods. Input is task-local JSON on stdin, output is counts
// and a status fingerprint, never conversation contents or native IDs.
import * as Net from "node:net";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const idleTypes = new Set(["idle", "notLoaded"]);
const endedTypes = new Set(["completed", "interrupted", "failed"]);
// ClientRequest__ThreadSourceKind in the generated native protocol schema.
export const sourceKinds = [
  "cli",
  "vscode",
  "appServer",
  "exec",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

export async function proveNativeIdle(rpc, bindings) {
  const statuses = [];
  const listed = new Map();
  for (const archived of [false, true]) {
    const cursors = new Set();
    let cursor = null;
    do {
      const page = await rpc("thread/list", {
        archived,
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sourceKinds,
        modelProviders: [],
      });
      if (page.error || !Array.isArray(page.result?.data)) throw Error("native-list-unavailable");
      for (const thread of page.result.data) {
        if (typeof thread.id !== "string" || !thread.id)
          throw Error("native-list-identity-unknown");
        if (listed.has(thread.id)) throw Error("native-list-duplicate");
        const type = thread.status?.type;
        if (!idleTypes.has(type)) {
          if (type === "active") return { idle: false, busy: true };
          throw Error("native-status-unknown");
        }
        statuses.push([thread.id, type]);
        listed.set(thread.id, type);
      }
      cursor = page.result.nextCursor ?? null;
      if (cursor !== null && (typeof cursor !== "string" || !cursor || cursors.has(cursor)))
        throw Error("native-pagination-uncertain");
      if (cursor !== null) cursors.add(cursor);
      if (cursors.size > 10000) throw Error("native-pagination-limit");
    } while (cursor !== null);
  }
  const reads = [];
  for (const { thread_id, native_id } of bindings) {
    if (typeof thread_id !== "string" || typeof native_id !== "string" || !native_id)
      throw Error("native-mapping-unknown");
    const read = await rpc("thread/read", { threadId: native_id, includeTurns: false });
    const thread = read.result?.thread;
    if (read.error || thread?.id !== native_id) throw Error("native-read-unavailable");
    if (!idleTypes.has(thread.status?.type)) {
      if (thread.status?.type === "active") return { idle: false, busy: true };
      throw Error("native-read-status-unknown");
    }
    if (listed.get(native_id) !== thread.status.type) throw Error("native-list-read-inconsistent");
    const turns = await rpc("thread/turns/list", {
      threadId: native_id,
      limit: 1,
      itemsView: "notLoaded",
      sortDirection: "desc",
    });
    if (turns.error || !Array.isArray(turns.result?.data) || turns.result.data.length !== 1)
      throw Error("native-latest-turn-unavailable");
    const turn = turns.result.data[0];
    if (!endedTypes.has(turn.status)) {
      if (turn.status === "inProgress") return { idle: false, busy: true };
      throw Error("native-latest-turn-unknown");
    }
    if (typeof turn.id !== "string" || !turn.id) throw Error("native-turn-identity-unknown");
    reads.push([thread_id, native_id, thread.status.type, turn.id, turn.status]);
  }
  statuses.sort((a, b) => a[0].localeCompare(b[0]));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([statuses, reads]))
    .digest("hex");
  return {
    idle: true,
    bindings_checked: bindings.length,
    threads_checked: statuses.length,
    fingerprint,
  };
}

async function main() {
  let socket;
  const pending = new Map();
  const timeout = setTimeout(() => {
    socket?.terminate();
    process.exitCode = 1;
  }, 110000);
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    const WebSocket = createRequire(request.ws_require_from)("ws");
    socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => Net.createConnection(request.socket),
    });
    let serial = 0;
    socket.on("message", (data) => {
      try {
        const reply = JSON.parse(data.toString());
        pending.get(reply.id)?.resolve(reply);
      } catch {
        socket.terminate();
      }
    });
    const rejectPending = () => {
      for (const request of pending.values()) request.reject(Error("native-socket-closed"));
    };
    socket.on("error", rejectPending);
    socket.on("close", rejectPending);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("native-rpc-timeout"));
        }, 10000);
        pending.set(id, {
          resolve: (reply) => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const init = await rpc("initialize", {
      clientInfo: { name: "t3_task_idle_guard", version: "1" },
      capabilities: { experimentalApi: true },
    });
    if (init.error) throw Error("native-initialize-rejected");
    socket.send(JSON.stringify({ method: "initialized" }));
    console.log(JSON.stringify(await proveNativeIdle(rpc, request.bindings)));
  } catch {
    console.error("native read-only idle proof unavailable");
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    socket?.terminate();
  }
}

if (process.argv[1] && import.meta.url === new URL("file:" + process.argv[1]).href) await main();
