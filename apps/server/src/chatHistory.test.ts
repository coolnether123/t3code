// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - The synthetic WebSocket peer sends raw protocol frames.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { WebSocketServer } from "ws";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { V2ThreadReadResponse__Thread } from "effect-codex-app-server/schema";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { readT3Chat, searchT3Chats } from "./chatHistory.ts";
import { readDaemonChat, searchDaemonChats, withChatDaemon } from "./provider/CodexChatHistory.ts";

const memory = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
const date = "2026-10-06T12:00:00.000Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('synthetic-project', 'Synthetic project', '/synthetic', '[]', ${date}, ${date})`;
  for (const [id, title, archived, deleted] of [
    ["active", "Synthetic title needle", null, null],
    ["archive", "Synthetic archive", date, null],
    ["deleted", "Synthetic needle", null, date],
  ] as const) {
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at) VALUES (${id}, 'synthetic-project', ${title}, '{"instanceId":"codex","model":"synthetic"}', 'full-access', 'default', ${date}, ${date}, ${archived}, ${deleted})`;
  }
  for (const [id, role, text, streaming] of [
    ["user", "user", "x".repeat(300) + "literal 100%_! needle", 0],
    ["assistant", "assistant", "Completed assistant needle", 0],
    ["interim", "assistant", "Interim hidden text", 0],
    ["stream", "user", "Streaming hidden text", 1],
    ["system", "system", "System hidden text", 0],
  ] as const) {
    yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (${id}, 'archive', ${role}, ${text}, ${streaming}, ${date}, ${date})`;
  }
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, assistant_message_id, state, requested_at, checkpoint_files_json) VALUES ('archive', 'synthetic-turn', 'assistant', 'completed', ${date}, '[]')`;
});

it.effect(
  "searches synthetic T3 names and archived messages, with literal text, dates and final replies",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const names = yield* searchT3Chats({ query: "title needle" });
      assert.deepEqual(
        names.matches.map((match) => match.threadId),
        ["active"],
      );
      const messages = yield* searchT3Chats({ query: "100%_!" });
      assert.equal(messages.matches[0]?.threadId, "archive");
      assert.isTrue(messages.matches[0]?.archived);
      assert.include(messages.matches[0]!.snippet, "100%_!");
      assert.lengthOf((yield* searchT3Chats({ query: "needle" })).matches, 2);
      assert.lengthOf((yield* searchT3Chats({ query: "hidden" })).matches, 0);
      assert.lengthOf(
        (yield* searchT3Chats({ query: "needle", from: date, before: "2026-10-07T00:00:00.000Z" }))
          .matches,
        2,
      );
      assert.lengthOf((yield* searchT3Chats({ query: "needle", before: date })).matches, 0);
      const read = yield* readT3Chat("archive");
      assert.deepEqual(read.messages.map((message) => message.role).sort(), ["assistant", "user"]);
      assert.isNull(read.nextOffset);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM projection_threads`)[0]?.count,
        3,
      );
    }).pipe(Effect.provide(memory)),
);

it.effect("bounds T3 results and pages read-only history without repeating messages", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    for (let index = 0; index < 55; index++) {
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at) VALUES (${`extra-${index}`}, 'synthetic-project', 'Many synthetic matches', '{"instanceId":"codex","model":"synthetic"}', 'full-access', 'default', ${date}, ${date})`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (${`extra-message-${index}`}, 'active', 'user', ${index === 0 ? "x".repeat(9000) : `Synthetic message ${index}`}, 0, ${date}, ${date})`;
    }
    const results = yield* searchT3Chats({ query: "Many synthetic" });
    assert.lengthOf(results.matches, 50);
    assert.equal(results.coverage[0]?.status, "partial");
    assert.equal(results.nextT3Offset, 50);
    const nextResults = yield* searchT3Chats({
      query: "Many synthetic",
      t3Offset: results.nextT3Offset!,
    });
    assert.lengthOf(nextResults.matches, 5);
    assert.equal(nextResults.coverage[0]?.status, "complete");
    assert.isNull(nextResults.nextT3Offset);
    assert.equal(
      new Set([...results.matches, ...nextResults.matches].map((match) => match.threadId)).size,
      55,
    );
    const first = yield* readT3Chat("active");
    const second = yield* readT3Chat("active", first.nextOffset!);
    assert.equal(first.nextOffset, 50);
    assert.lengthOf(first.messages, 50);
    assert.lengthOf(second.messages, 5);
    assert.isTrue(second.truncated);
    assert.isAtMost(Math.max(...second.messages.map((message) => message.text.length)), 8000);
    assert.isNull(second.nextOffset);
  }).pipe(Effect.provide(memory)),
);

const syntheticThread = (id: string, text: string): V2ThreadReadResponse__Thread => ({
  id,
  sessionId: id,
  cliVersion: "synthetic",
  createdAt: 1791288000,
  updatedAt: 1791288000,
  cwd: "/synthetic",
  ephemeral: false,
  modelProvider: "synthetic",
  source: "appServer",
  status: { type: "idle" },
  name: "Synthetic Codex name",
  preview: "Synthetic preview",
  turns: [
    {
      id: "synthetic-turn",
      status: "completed",
      startedAt: 1791288000,
      items: [
        { type: "userMessage", id: "u", content: [{ type: "text", text, text_elements: [] }] },
        { type: "agentMessage", id: "a", text: "Synthetic final reply" },
      ],
    },
  ],
});

it.effect(
  "finds a slow daemon history and retries a timed-out read without skipping the chat",
  () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = {
        request: (method: string, params: { limit?: number }) => {
          if (method === "thread/list") {
            assert.equal(params.limit, 1);
            return Effect.succeed({
              data: [syntheticThread("slow", "Slow message needle")],
              nextCursor: null,
            });
          }
          throw new Error("Unexpected typed request");
        },
        raw: {
          request: () =>
            Effect.suspend(() => {
              attempts++;
              return attempts === 1
                ? Effect.never
                : Effect.succeed({ thread: syntheticThread("slow", "Slow message needle") });
            }),
        },
      } as unknown as Parameters<typeof searchDaemonChats>[0];
      const fiber = yield* searchDaemonChats(client, { query: "message needle" }).pipe(
        Effect.forkScoped,
      );
      yield* TestClock.adjust("15 seconds");
      const result = yield* Fiber.join(fiber);
      assert.equal(attempts, 2);
      assert.equal(result.matches[0]?.threadId, "slow");
      assert.equal(result.coverage[0]?.readGaps, false);
    }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps an explicit gap after both bounded daemon reads time out", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const client = {
      request: (method: string) =>
        method === "thread/list"
          ? Effect.succeed({ data: [syntheticThread("unresponsive", "")], nextCursor: null })
          : Effect.die("Unexpected typed request"),
      raw: {
        request: () =>
          Effect.suspend(() => {
            attempts++;
            return Effect.never;
          }),
      },
    } as unknown as Parameters<typeof searchDaemonChats>[0];
    const fiber = yield* searchDaemonChats(client, { query: "needle" }).pipe(Effect.forkScoped);
    yield* TestClock.adjust("30 seconds");
    const result = yield* Fiber.join(fiber);
    assert.equal(attempts, 2);
    assert.lengthOf(result.matches, 0);
    assert.equal(result.coverage[0]?.readGaps, true);
  }).pipe(Effect.provide(TestClock.layer())),
);

async function syntheticDaemon(platform: NodeJS.Platform) {
  const homePath =
    platform === "win32"
      ? `\\\\.\\pipe\\t3-chat-synthetic-${NodeCrypto.randomUUID()}`
      : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chat-synthetic-"));
  const socketPath = `${homePath}/app-server-control/app-server-control.sock`;
  if (platform !== "win32") await NodeFSP.mkdir(NodePath.dirname(socketPath), { recursive: true });
  const server = NodeHttp.createServer();
  const sockets = new WebSocketServer({ server });
  const methods: string[] = [];
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id?: number;
        method: string;
        params: { archived?: boolean; threadId?: string; cursor?: string };
      };
      methods.push(request.method);
      if (request.id === undefined) return;
      if (request.method === "initialize")
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              codexHome: homePath,
              platformFamily: "unix",
              platformOs: "macos",
              userAgent: "synthetic",
            },
          }),
        );
      else if (request.method === "thread/list")
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              data: request.params.archived
                ? [
                    syntheticThread("archived", "Archived needle"),
                    syntheticThread("undated", "Undated needle"),
                  ]
                : [syntheticThread("active", "Text needle"), syntheticThread("unreadable", "")],
              nextCursor: null,
            },
          }),
        );
      else if (request.method === "thread/read") {
        const thread = syntheticThread(
          request.params.threadId!,
          request.params.threadId === "archived" ? "Archived needle" : "Text needle",
        );
        const history =
          request.params.threadId === "undated"
            ? { ...thread, turns: thread.turns.map((turn) => ({ ...turn, startedAt: null })) }
            : thread;
        socket.send(
          JSON.stringify(
            request.params.threadId === "unreadable"
              ? { id: request.id, error: { code: -32000, message: "Synthetic read failure" } }
              : {
                  id: request.id,
                  result: {
                    thread: {
                      ...history,
                      turns: history.turns.map((turn) => ({
                        ...turn,
                        items: [
                          ...turn.items,
                          { type: "futureToolResult", payload: { unknown: true } },
                        ],
                      })),
                    },
                  },
                },
          ),
        );
      } else
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: "Read-only synthetic peer" },
          }),
        );
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    homePath,
    methods,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (platform !== "win32") await NodeFSP.rm(homePath, { recursive: true });
    },
  };
}

it.effect(
  "searches and opens synthetic Codex daemon histories, including archives and unreadable coverage",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const peer = yield* Effect.promise(() => syntheticDaemon(platform));
      try {
        const first = yield* Effect.scoped(
          withChatDaemon(peer.homePath, (client) => searchDaemonChats(client, { query: "needle" })),
        );
        assert.deepEqual(
          first.matches.map((match) => match.threadId),
          ["active"],
        );
        assert.equal(first.coverage[0]?.status, "partial");
        assert.include(first.coverage[0]!.detail, "could not be read");
        assert.isNotNull(first.nextCodexCursor);
        const unreadableName = yield* Effect.scoped(
          withChatDaemon(peer.homePath, (client) =>
            searchDaemonChats(client, { query: "Codex name" }),
          ),
        );
        assert.deepEqual(
          unreadableName.matches.map((match) => match.threadId),
          ["active", "unreadable"],
        );
        assert.equal(unreadableName.coverage[0]?.readGaps, true);
        const archive = yield* Effect.scoped(
          withChatDaemon(peer.homePath, (client) =>
            searchDaemonChats(client, { query: "needle", codexCursor: first.nextCodexCursor! }),
          ),
        );
        assert.equal(archive.matches[0]?.threadId, "archived");
        assert.lengthOf(archive.matches, 2);
        assert.isTrue(archive.matches[0]?.archived);
        assert.isNull(archive.nextCodexCursor);
        const dates = yield* Effect.scoped(
          withChatDaemon(peer.homePath, (client) =>
            searchDaemonChats(client, {
              query: "needle",
              from: "2026-10-07T00:00:00.000Z",
              codexCursor: first.nextCodexCursor!,
            }),
          ),
        );
        assert.lengthOf(dates.matches, 0);
        assert.equal(dates.coverage[0]?.readGaps, true);
        assert.include(dates.coverage[0]!.detail, "no date");
        const names = yield* Effect.scoped(
          withChatDaemon(peer.homePath, (client) =>
            searchDaemonChats(client, { query: "Codex name", codexCursor: first.nextCodexCursor! }),
          ),
        );
        assert.lengthOf(names.matches, 2);
        const read = yield* Effect.scoped(
          withChatDaemon(peer.homePath, (client) => readDaemonChat(client, "archived")),
        );
        assert.deepEqual(
          read.messages.map((message) => message.text),
          ["Archived needle", "Synthetic final reply"],
        );
        assert.deepEqual([...new Set(peer.methods)].sort(), [
          "initialize",
          "initialized",
          "thread/list",
          "thread/read",
        ]);
      } finally {
        yield* Effect.promise(peer.close);
      }
    }),
);
