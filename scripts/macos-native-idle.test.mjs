import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as native from "./macos-native-idle.mjs";
const { proveNativeIdle, sourceKinds } = native;

const bindings = [{ thread_id: "t3", native_id: "native" }];
const thread = { id: "native", status: { type: "idle" } };
const replies = () => ({
  "thread/list": { result: { data: [thread], nextCursor: null } },
  "thread/read": { result: { thread } },
  "thread/turns/list": { result: { data: [{ id: "last", status: "completed" }] } },
});
const fixtureRpc = (fixture) => async (method, params) =>
  method === "thread/list" && params.archived
    ? { result: { data: [], nextCursor: null } }
    : fixture[method];

NodeTest.test("T3-owned proof reads only pinned native threads", async () => {
  const methods = [];
  const proof = await proveNativeIdle(async (method, params) => {
    methods.push(method);
    NodeAssert.notEqual(method, "thread/list");
    NodeAssert.equal(params.threadId, "native");
    return replies()[method];
  }, bindings, true);
  NodeAssert.equal(proof.idle, true);
  NodeAssert.deepEqual(methods, ["thread/read", "thread/turns/list"]);
});

NodeTest.test("T3-owned proof still refuses active turns and unknown native identity", async () => {
  for (const status of ["inProgress", "unknown"]) {
    const fixture = replies();
    fixture["thread/turns/list"].result.data[0].status = status;
    if (status === "inProgress") {
      NodeAssert.equal((await proveNativeIdle(fixtureRpc(fixture), bindings, true)).busy, true);
    } else {
      await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings, true));
    }
  }
  const fixture = replies();
  fixture["thread/read"].result.thread = { ...thread, id: "other-chat" };
  await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings, true));
});

NodeTest.test("only read-only native methods and notLoaded turn items", async () => {
  const fixture = replies();
  const methods = [];
  const proof = await proveNativeIdle(async (method, params) => {
    methods.push(method);
    if (method === "thread/list") {
      NodeAssert.deepEqual(params.sourceKinds, [
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
      ]);
    }
    if (method === "thread/read") NodeAssert.equal(params.includeTurns, false);
    if (method === "thread/turns/list") NodeAssert.equal(params.itemsView, "notLoaded");
    return fixtureRpc(fixture)(method, params);
  }, bindings);
  NodeAssert.equal(proof.idle, true);
  NodeAssert.equal(proof.bindings_checked, 1);
  NodeAssert.deepEqual(methods, ["thread/list", "thread/list", "thread/read", "thread/turns/list"]);
});

NodeTest.test("active Elora native root refuses, including later list pages", async () => {
  let page = 0;
  const proof = await proveNativeIdle(async (method) => {
    NodeAssert.equal(method, "thread/list");
    return ++page === 1
      ? { result: { data: [thread], nextCursor: "second" } }
      : { result: { data: [{ id: "root", status: { type: "active" } }], nextCursor: null } };
  }, bindings);
  NodeAssert.equal(page, 2);
  NodeAssert.equal(proof.busy, true);
});

for (const [name, mutation] of [
  [
    "unknown mapping",
    (r) => {
      r["thread/read"].result.thread = { ...thread, id: "wrong" };
    },
  ],
  [
    "unknown native status",
    (r) => {
      r["thread/list"].result.data = [{ ...thread, status: { type: "mystery" } }];
    },
  ],
  [
    "RPC errors",
    (r) => {
      r["thread/turns/list"] = { error: { code: 1 } };
    },
  ],
  [
    "unknown turn",
    (r) => {
      r["thread/turns/list"].result.data = [{ id: "turn", status: "unknown" }];
    },
  ],
  [
    "empty latest turn",
    (r) => {
      r["thread/turns/list"].result.data = [];
    },
  ],
]) {
  NodeTest.test(name + " holds", async () => {
    const fixture = replies();
    mutation(fixture);
    await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings));
  });
}

NodeTest.test("inProgress turn is busy despite idle native thread", async () => {
  const fixture = replies();
  fixture["thread/turns/list"].result.data[0].status = "inProgress";
  NodeAssert.equal((await proveNativeIdle(fixtureRpc(fixture), bindings)).busy, true);
});

NodeTest.test("repeated pagination cursor holds", async () => {
  await NodeAssert.rejects(
    proveNativeIdle(async () => ({ result: { data: [thread], nextCursor: "repeated" } }), []),
  );
});

NodeTest.test("active child and archived native turns are never omitted", async () => {
  for (const archived of [false, true]) {
    for (const kind of sourceKinds.filter((value) => value.startsWith("subAgent"))) {
      const observed = [];
      const proof = await proveNativeIdle(async (method, params) => {
        NodeAssert.equal(method, "thread/list");
        observed.push(params.archived);
        NodeAssert.ok(params.sourceKinds.includes(kind));
        return {
          result: {
            data:
              params.archived === archived
                ? [{ id: "child", source: kind, status: { type: "active" } }]
                : [],
            nextCursor: null,
          },
        };
      }, []);
      NodeAssert.equal(proof.busy, true);
      NodeAssert.deepEqual(observed, archived ? [false, true] : [false]);
    }
  }
});

NodeTest.test("inconsistent list/read state and duplicates hold", async () => {
  const fixture = replies();
  fixture["thread/read"].result.thread = { ...thread, status: { type: "notLoaded" } };
  await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings));
  fixture["thread/list"].result.data = [thread, thread];
  await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings));
});

NodeTest.test(
  "native transport deadlines reject and terminate without admitting incomplete scans",
  async () => {
    for (const [deadline, reason] of [
      [30_000, "native-rpc-timeout:initialize"],
      [600_000, "native-proof-timeout"],
    ]) {
      const scheduled = new Map();
      const timers = {
        setTimeout(callback, delay) {
          const key = {};
          scheduled.set(key, { callback, delay });
          return key;
        },
        clearTimeout(key) {
          scheduled.delete(key);
        },
      };
      let socket;
      class Socket extends NodeEvents.EventEmitter {
        constructor() {
          super();
          socket = this;
        }
        send() {}
        terminate() {
          this.terminated = true;
          this.emit("close");
        }
      }
      const proof = native.readNativeIdle({ bindings: [] }, Socket, timers);
      socket.emit("open");
      await Promise.resolve();
      const expiry = [...scheduled.entries()].find(([, { delay }]) => delay === deadline);
      NodeAssert.ok(expiry, "bounded native deadline must be installed");
      scheduled.delete(expiry[0]);
      expiry[1].callback();
      await NodeAssert.rejects(proof, { message: reason });
      NodeAssert.equal(socket.terminated, true);
      NodeAssert.equal(scheduled.size, 0);
    }
  },
);

NodeTest.test("native connection closure before open holds instead of hanging", async () => {
  let socket;
  class Socket extends NodeEvents.EventEmitter {
    constructor() {
      super();
      socket = this;
    }
    terminate() {}
  }
  const proof = native.readNativeIdle({ bindings: [] }, Socket);
  socket.emit("close");
  await NodeAssert.rejects(proof, { message: "native-connect-unavailable" });
});

NodeTest.test(
  "native transport completes full proof and preserves active-thread refusal",
  async () => {
    for (const active of [false, true]) {
      let socket;
      const methods = [];
      class Socket extends NodeEvents.EventEmitter {
        constructor() {
          super();
          socket = this;
        }
        send(input) {
          const { id, method } = JSON.parse(input);
          methods.push(method);
          if (id === undefined) return;
          const result =
            method === "initialize"
              ? {}
              : {
                  data: active ? [{ id: "root", status: { type: "active" } }] : [],
                  nextCursor: null,
                };
          this.emit("message", JSON.stringify({ id, result }));
        }
        terminate() {
          this.terminated = true;
          this.emit("close");
        }
      }
      const proof = native.readNativeIdle({ bindings: [] }, Socket);
      socket.emit("open");
      const result = await proof;
      NodeAssert.equal(active ? result.busy : result.idle, true);
      NodeAssert.deepEqual(
        methods,
        active
          ? ["initialize", "initialized", "thread/list"]
          : ["initialize", "initialized", "thread/list", "thread/list"],
      );
      NodeAssert.equal(socket.terminated, true);
    }
  },
);
