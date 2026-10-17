import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { proveNativeIdle, sourceKinds } from "./macos-native-idle.mjs";

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
