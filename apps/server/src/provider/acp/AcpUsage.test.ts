// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CursorSettings, GrokSettings, ThreadId, TurnId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import {
  AcpUsageMetadata,
  makeAcpUsageCapture,
  readAcpPromptUsage,
  readAcpSessionUsage,
} from "./AcpUsage.ts";

const counters = {
  inputTokens: 10,
  outputTokens: 5,
  cachedReadTokens: 2,
  cachedWriteTokens: 1,
  thoughtTokens: 3,
  totalTokens: 15,
};
const LogRecord = Schema.Struct({
  event: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("usage"),
    payload: AcpUsageMetadata,
  }),
});
const decodeRecord = Schema.decodeUnknownSync(LogRecord);
const decodeLogJson = Schema.decodeUnknownSync(Schema.fromJsonString(LogRecord));
const isUsageRecord = Schema.is(
  Schema.Struct({ event: Schema.Struct({ kind: Schema.Literal("usage") }) }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const threadId = ThreadId.make("synthetic-usage-thread");
const turnId = TurnId.make("synthetic-turn");

function collectingLogger(records: Array<unknown>): EventNdjsonLogger {
  return {
    filePath: "synthetic-native.ndjson",
    write: (event) => Effect.sync(() => void records.push(event)),
    close: () => Effect.void,
  };
}

it("keeps missing counters null, including absent and null usage", () => {
  for (const response of [{}, { usage: null }, { usage: {} }]) {
    const observation = readAcpPromptUsage(response);
    assert.equal(observation.tokenBasis, "unavailable");
    assert.isFalse(observation.scopeConflict);
    assert.isTrue(Object.values(observation.requestTokens).every((value) => value === null));
  }
});

it("admits counters only under an explicit per-request contract", () => {
  const observation = readAcpPromptUsage({ usage: counters }, "request");
  assert.equal(observation.tokenBasis, "request");
  assert.deepEqual(observation.requestTokens, counters);
  assert.deepEqual(observation.reportedTokens, counters);
  assert.isFalse(observation.scopeConflict);
  assert.deepEqual(observation.invalidFields, []);
  const partial = readAcpPromptUsage({ usage: { inputTokens: 0 } }, "request");
  assert.equal(partial.requestTokens.inputTokens, 0);
  assert.isNull(partial.requestTokens.outputTokens);
  assert.isNull(partial.requestTokens.cachedReadTokens);
});

it("retains contradictory ACP scope without subtracting cumulative observations", () => {
  for (const inputTokens of [10, 20, 5]) {
    const observation = readAcpPromptUsage({ usage: { ...counters, inputTokens } });
    assert.equal(observation.tokenBasis, "ambiguous");
    assert.isTrue(observation.scopeConflict);
    assert.equal(observation.reportedTokens.inputTokens, inputTokens);
    assert.isNull(observation.requestTokens.inputTokens);
  }
  assert.deepEqual(
    readAcpSessionUsage({ used: 200, size: 1000, cost: { amount: 1.5, currency: "EUR" } }),
    {
      source: "usage-update",
      tokenBasis: "session",
      contextUsedTokens: 200,
      contextSizeTokens: 1000,
      sessionCost: { amount: 1.5, currency: "EUR" },
      invalidFields: [],
    },
  );
});

it("rejects unsafe counters and reads only fixed data properties", () => {
  const usage = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(usage, "inputTokens", {
    get: () => {
      throw new Error("must not invoke");
    },
  });
  Object.assign(usage, {
    outputTokens: Number.MAX_SAFE_INTEGER + 1,
    cachedReadTokens: -1,
    cachedWriteTokens: Infinity,
    thoughtTokens: "123",
    totalTokens: 1.5,
    _meta: Array.from({ length: 100_000 }, () => "synthetic-private-payload"),
  });
  const observation = readAcpPromptUsage({ usage });
  assert.deepEqual(observation.invalidFields, [
    "inputTokens",
    "outputTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
    "thoughtTokens",
    "totalTokens",
  ]);
  assert.isTrue(Object.values(observation.reportedTokens).every((value) => value === null));
  assert.notInclude(encodeJson(observation), "synthetic-private-payload");
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error("unreadable");
      },
    },
  );
  assert.deepEqual(readAcpPromptUsage(hostile).invalidFields, ["usage"]);
  assert.deepEqual(readAcpPromptUsage({ usage: [counters] }).invalidFields, ["usage"]);
  const snapshot = readAcpSessionUsage({
    used: NaN,
    size: -2,
    cost: { amount: NaN, currency: "secret" },
  });
  assert.deepEqual(snapshot.invalidFields, ["cost", "used", "size"]);
  assert.isNull(snapshot.sessionCost);
  assert.deepEqual(readAcpSessionUsage({ cost: { amount: -1, currency: "USD" } }).sessionCost, {
    amount: -1,
    currency: "USD",
  });
});

it.layer(NodeServices.layer)("ACP usage receipts", (it) => {
  for (const provider of ["cursor", "grok"] as const) {
    it.effect(`${provider} deduplicates receipts and marks conflicting updates`, () =>
      Effect.gen(function* () {
        const records: Array<unknown> = [];
        const capture = yield* makeAcpUsageCapture({
          provider,
          threadId,
          nativeSessionId: "synthetic-session",
          nativeEventLogger: collectingLogger(records),
        });
        const receipt = {
          turnId,
          requestId: "request-1",
          outcome: "succeeded" as const,
          response: { usage: counters, _meta: { secret: "synthetic-private" } },
        };
        yield* capture.capturePrompt(receipt);
        yield* capture.capturePrompt(receipt);
        yield* capture.capturePrompt({
          ...receipt,
          response: {
            usage: { ...counters, inputTokens: 11 },
            userMessageId: "wrong-acknowledgement",
          },
        });
        yield* capture.capturePrompt({ ...receipt, requestId: "request-2" });
        assert.lengthOf(records, 3);
        const [first, conflict, distinct] = records.map((record) => decodeRecord(record));
        assert.equal(first!.event.id, conflict!.event.id);
        assert.notEqual(first!.event.id, distinct!.event.id);
        const metadata = conflict!.event.payload;
        assert.equal(metadata.source, "prompt-response");
        if (metadata.source !== "prompt-response") return;
        assert.isTrue(metadata.receiptConflict);
        assert.isTrue(metadata.acknowledgementMismatch);
        assert.deepEqual(metadata.previousReportedTokens, counters);
        assert.equal(metadata.reportedTokens.inputTokens, 11);
        assert.notInclude(encodeJson(records), "synthetic-private");
        assert.notInclude(encodeJson(records), "wrong-acknowledgement");
      }),
    );

    it.effect(`${provider} separates session updates and excludes replay and child sessions`, () =>
      Effect.gen(function* () {
        const records: Array<unknown> = [];
        const capture = yield* makeAcpUsageCapture({
          provider,
          threadId,
          nativeSessionId: "synthetic-session",
          nativeEventLogger: collectingLogger(records),
        });
        const notification = {
          sessionId: "synthetic-session",
          update: {
            sessionUpdate: "usage_update",
            used: 50,
            size: 100,
            cost: { amount: 1, currency: "USD" },
          },
        } satisfies AcpSchema.SessionNotification;
        yield* capture.captureSessionUpdate(notification);
        yield* capture.captureSessionUpdate(notification);
        yield* capture.captureSessionUpdate({ ...notification, sessionId: "synthetic-child" });
        yield* capture.captureSessionUpdate({
          ...notification,
          _meta: { isReplay: true },
          update: { ...notification.update, used: 30 },
        });
        yield* capture.captureSessionUpdate({
          ...notification,
          update: { ...notification.update, used: 40 },
        });
        const snapshots = records
          .map((record) => decodeRecord(record))
          .map((record) => record.event.payload);
        assert.lengthOf(snapshots, 2);
        for (const snapshot of snapshots) {
          assert.equal(snapshot.source, "usage-update");
          assert.isNull(snapshot.turnId);
          assert.isNull(snapshot.requestId);
        }
      }),
    );

    it.effect(`${provider} records interrupted completion without inventing usage`, () =>
      Effect.gen(function* () {
        const records: Array<unknown> = [];
        const capture = yield* makeAcpUsageCapture({
          provider,
          threadId,
          nativeSessionId: "synthetic-session",
          nativeEventLogger: collectingLogger(records),
        });
        yield* capture.capturePromptExit(turnId, "request-1")(Exit.interrupt());
        const payload = decodeRecord(records[0]).event.payload;
        assert.equal(payload.source, "prompt-response");
        if (payload.source !== "prompt-response") return;
        assert.equal(payload.outcome, "interrupted");
        assert.equal(payload.tokenBasis, "unavailable");
        assert.isNull(payload.reportedTokens.inputTokens);
        const disabled = yield* makeAcpUsageCapture({
          provider,
          threadId,
          nativeSessionId: "synthetic-session",
          nativeEventLogger: undefined,
        });
        yield* disabled.capturePrompt({ turnId, requestId: "request", outcome: "failed" });
      }),
    );
  }

  it.effect("bounds the recent receipt window without changing durable identity", () =>
    Effect.gen(function* () {
      const records: Array<unknown> = [];
      const capture = yield* makeAcpUsageCapture({
        provider: "cursor",
        threadId,
        nativeSessionId: "synthetic-session",
        nativeEventLogger: collectingLogger(records),
      });
      for (let index = 0; index < 257; index++) {
        yield* capture.capturePrompt({
          turnId,
          requestId: `request-${index}`,
          outcome: "succeeded",
        });
      }
      yield* capture.capturePrompt({ turnId, requestId: "request-0", outcome: "succeeded" });
      assert.lengthOf(records, 258);
      assert.equal(decodeRecord(records[0]).event.id, decodeRecord(records[257]).event.id);
    }),
  );

  it.effect("does not let unavailable logging fail a prompt receipt or leak a cause", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    return Effect.gen(function* () {
      const capture = yield* makeAcpUsageCapture({
        provider: "cursor",
        threadId,
        nativeSessionId: "synthetic-session",
        nativeEventLogger: {
          filePath: "synthetic-native.ndjson",
          write: () => Effect.die(new Error("synthetic-private-failure")),
          close: () => Effect.void,
        },
      });
      yield* capture.capturePrompt({
        turnId,
        requestId: "request-1",
        outcome: "succeeded",
        response: { usage: counters },
      });
      assert.notInclude(encodeJson(messages), "synthetic-private-failure");
      assert.include(encodeJson(messages), "Failed to retain ACP usage metadata.");
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("flushes typed usage metadata through the existing native log writer", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "synthetic-acp-usage-log-")),
      );
      const nativeEventLogger = yield* makeEventNdjsonLogger(
        NodePath.join(directory, "provider.ndjson"),
        { stream: "native" },
      );
      assert.isDefined(nativeEventLogger);
      const capture = yield* makeAcpUsageCapture({
        provider: "grok",
        threadId,
        nativeSessionId: "synthetic-session",
        nativeEventLogger,
      });
      yield* capture.capturePrompt({
        turnId,
        requestId: "request-1",
        outcome: "succeeded",
        response: { usage: counters, _meta: { prompt: "synthetic-private" } },
      });
      yield* nativeEventLogger!.close();
      const line = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, `provider.${threadId}.log`), "utf8"),
      );
      assert.match(line, /^\[[^\]]+\] NTIVE: /);
      const record = decodeLogJson(line.slice(line.indexOf("NTIVE: ") + 7).trim());
      assert.equal(record.event.payload.source, "prompt-response");
      assert.equal(record.event.payload.nativeSessionId, "synthetic-session");
      assert.notInclude(line, "synthetic-private");
    }),
  );
});

// Synthetic wire runtime. It never invokes a provider or reads credentials.
const syntheticAgent = `
import { createInterface } from "node:readline";
let count = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  let result = { configOptions: [] };
  if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (request.method === "session/new") result = { sessionId: "synthetic-wire-session", configOptions: [] };
  if (request.method === "session/prompt") {
    if (typeof request.params.messageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.params.messageId)) {
      send({ id: request.id, error: { code: -32602, message: "synthetic fixture requires a dispatched UUID messageId" } });
      return;
    }
    count++;
    const update = { sessionId: "synthetic-wire-session", update: { sessionUpdate: "usage_update", used: 100 + count, size: 1000, cost: { amount: count, currency: "USD" }, _meta: { secret: "synthetic-private" } } };
    send({ method: "session/update", params: update });
    send({ method: "session/update", params: update });
    send({ method: "session/update", params: { ...update, sessionId: "synthetic-child" } });
    if (count === 5) {
      send({ method: "session/update", params: { sessionId: "synthetic-wire-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "synthetic interrupt receipt" } } } });
      return;
    }
    result = { stopReason: count === 4 ? "cancelled" : "end_turn", userMessageId: request.params.messageId,
      ...(count === 3 ? {} : { usage: { inputTokens: 10 * count, outputTokens: 5, totalTokens: 10 * count + 5, cachedReadTokens: 2, thoughtTokens: 3 } }),
      _meta: { answer: "synthetic-private" } };
  }
  send({ id: request.id, result });
});
`;

const runtimeLayer = ServerConfig.layerTest(process.cwd(), { prefix: "synthetic-acp-usage-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(runtimeLayer)("ACP adapter usage integration", (it) => {
  for (const provider of ["cursor", "grok"] as const) {
    it.effect(`${provider} retains sanitized wire usage through completion and interruption`, () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "synthetic-acp-usage-")),
        );
        const binaryPath = writeFakeCli({
          directory,
          name: "synthetic-agent",
          source: syntheticAgent,
        });
        const records: Array<unknown> = [];
        const nativeEventLogger = collectingLogger(records);
        const adapter =
          provider === "cursor"
            ? yield* makeCursorAdapter(decodeCursorSettings({ binaryPath }), {
                nativeEventLogger,
              })
            : yield* makeGrokAdapter(decodeGrokSettings({ binaryPath }), {
                nativeEventLogger,
              });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnIds: string[] = [];
        for (let index = 0; index < 4; index++) {
          const result = yield* adapter.sendTurn({ threadId, input: "synthetic prompt" });
          turnIds.push(result.turnId!);
        }
        const content = yield* Deferred.make<void>();
        const consumer = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "content.delta"
            ? Deferred.succeed(content, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ).pipe(Effect.forkChild);
        const running = yield* adapter
          .sendTurn({ threadId, input: "synthetic interrupted prompt" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(content);
        yield* Fiber.interrupt(running);
        yield* Fiber.interrupt(consumer);
        const usageRecords = records.filter(isUsageRecord).map((record) => decodeRecord(record));
        const requests = usageRecords
          .map((record) => record.event.payload)
          .filter((payload) => payload.source === "prompt-response");
        const snapshots = usageRecords
          .map((record) => record.event.payload)
          .filter((payload) => payload.source === "usage-update");
        assert.lengthOf(requests, 5);
        assert.lengthOf(snapshots, 5);
        assert.deepEqual(
          requests.slice(0, 4).map((request) => request.turnId),
          turnIds,
        );
        assert.equal(new Set(requests.map((request) => request.requestId)).size, 5);
        assert.isTrue(
          requests.every((request) => request.nativeSessionId === "synthetic-wire-session"),
        );
        assert.isTrue(requests.every((request) => !request.acknowledgementMismatch));
        assert.deepEqual(
          requests.map((request) => request.reportedTokens.inputTokens),
          [10, 20, null, 40, null],
        );
        assert.isTrue(requests.every((request) => request.requestTokens.inputTokens === null));
        assert.equal(requests[2]!.tokenBasis, "unavailable");
        assert.equal(requests[3]!.outcome, "cancelled");
        assert.equal(requests[4]!.outcome, "interrupted");
        assert.isTrue(
          snapshots.every((snapshot) => snapshot.turnId === null && snapshot.requestId === null),
        );
        assert.notInclude(encodeJson(usageRecords), "synthetic-private");
        assert.notInclude(encodeJson(usageRecords), "synthetic prompt");
        yield* adapter.stopSession(threadId);
      }),
    );
  }
});
