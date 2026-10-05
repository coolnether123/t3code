// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqlite from "node:sqlite";

import * as CodexDesktopStore from "./CodexDesktopStore.ts";

const threadId = "019e487f-4854-7902-8efb-61feec0364bf";

const makeFixture = (): string => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-desktop-"));
  const state = new NodeSqlite.DatabaseSync(NodePath.join(home, "state_1.sqlite"));
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, created_at_ms INTEGER,
      updated_at INTEGER, updated_at_ms INTEGER, preview TEXT, cwd TEXT, archived INTEGER,
      rollout_path TEXT, history_mode TEXT, thread_source TEXT
    );
    INSERT INTO threads VALUES ('${threadId}', 'Native fixture', 1, 1000, 1, 1000, 'latest', 'A:/Dev', 0, '', 'paginated', 'user');
  `);
  state.close();
  const history = new NodeSqlite.DatabaseSync(NodePath.join(home, "thread_history_1.sqlite"));
  history.exec(`
    CREATE TABLE thread_items (
      thread_id TEXT, item_id TEXT, item_type TEXT, item_json TEXT,
      created_at_ms INTEGER, rollout_ordinal INTEGER
    );
    INSERT INTO thread_items VALUES
      ('${threadId}', 'm1', 'reasoning', '{"type":"reasoning","id":"r1","summary":[]}', 1000, 1),
      ('${threadId}', 'm2', 'userMessage', '{"type":"userMessage","id":"m2","content":[{"type":"text","text":"hello"}]}', 1100, 2),
      ('${threadId}', 'm3', 'agentMessage', '{"type":"agentMessage","id":"m3","text":"world"}', 1200, 3),
      ('${threadId}', 'm4', 'commandExecution', '{"type":"commandExecution","id":"m4","command":"dir","status":"completed"}', 1300, 4),
      ('${threadId}', 'm5', 'functionCallOutput', '{"type":"functionCallOutput","id":"m5","name":"send_message_to_thread","output":"done"}', 1400, 5);
  `);
  history.close();
  return home;
};

const makeLargeLegacyFixture = (): { readonly home: string; readonly threadId: string } => {
  const legacyThreadId = "019e487f-4854-7902-8efb-61feec0364c0";
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-legacy-"));
  const rollout = NodePath.join(home, "sessions", `${legacyThreadId}.jsonl`);
  NodeFS.mkdirSync(NodePath.dirname(rollout), { recursive: true });
  const event = (type: string, text: string) =>
    `${JSON.stringify({ type, payload: type === "event_msg" ? { type: "user_message", message: text } : { type: "message", role: "assistant", content: [{ text }] } })}\n`;
  NodeFS.writeFileSync(
    rollout,
    event("event_msg", "old marker") +
      event("response_item", "x".repeat(160)).repeat(70_000) +
      event("response_item", "new marker"),
  );
  const state = new NodeSqlite.DatabaseSync(NodePath.join(home, "state_1.sqlite"));
  state.exec(
    `CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,created_at_ms INTEGER,updated_at INTEGER,updated_at_ms INTEGER,preview TEXT,cwd TEXT,archived INTEGER,rollout_path TEXT,history_mode TEXT,thread_source TEXT);`,
  );
  state
    .prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      legacyThreadId,
      "Large legacy",
      1,
      1000,
      1,
      1000,
      "new marker",
      "A:/Dev",
      0,
      rollout,
      "legacy",
      "user",
    );
  state.close();
  return { home, threadId: legacyThreadId };
};

const testLayer = (home: string) =>
  CodexDesktopStore.layerWithHomePath(home).pipe(Layer.provide(NodeServices.layer));

it.effect("reads native paginated history without exposing reasoning", () => {
  const home = makeFixture();
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    const list = yield* store.listThreads({ limit: 1 });
    expect(list.threads).toHaveLength(1);
    expect((yield* store.listScheduledRoutines()).routines).toEqual([]);
    const history = yield* store.readThread(threadId, { limit: 3 });
    expect(history.messages.map((message) => message.text)).toEqual(["world", "dir", "done"]);
    expect(history.messages[2]?.tool?.name).toBe("send_message_to_thread");
    const older = yield* store.readThread(threadId, {
      ...(history.nextCursor === null ? {} : { beforeCursor: history.nextCursor }),
      limit: 1,
    });
    expect(older.messages.map((message) => message.text)).toEqual(["hello"]);
  }).pipe(
    Effect.provide(testLayer(home)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
  );
});

it.effect("keeps ordinary history readable when the native index predates thread_source", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-old-index-"));
  const state = new NodeSqlite.DatabaseSync(NodePath.join(home, "state_1.sqlite"));
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER, updated_at_ms INTEGER,
      preview TEXT, cwd TEXT, archived INTEGER, rollout_path TEXT, history_mode TEXT
    );
    INSERT INTO threads VALUES ('${threadId}', 'Old index', 1, 1000, 'latest', 'A:/Dev', 0, '', 'paginated');
  `);
  state.close();
  const history = new NodeSqlite.DatabaseSync(NodePath.join(home, "thread_history_1.sqlite"));
  history.exec(`
    CREATE TABLE thread_items (
      thread_id TEXT, item_id TEXT, item_type TEXT, item_json TEXT,
      created_at_ms INTEGER, rollout_ordinal INTEGER
    );
    INSERT INTO thread_items VALUES
      ('${threadId}', 'm1', 'agentMessage', '{"type":"agentMessage","text":"still readable"}', 1000, 1);
  `);
  history.close();
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    expect((yield* store.listThreads()).threads).toHaveLength(1);
    expect((yield* store.readThread(threadId)).messages.map((message) => message.text)).toEqual([
      "still readable",
    ]);
  }).pipe(
    Effect.provide(testLayer(home)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
  );
});

it.effect("pages a large legacy rollout from a bounded byte cursor", () => {
  const fixture = makeLargeLegacyFixture();
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    const newest = yield* store.readThread(fixture.threadId, { limit: 1 });
    expect(newest.messages[0]?.text).toBe("new marker");
    expect(newest.nextCursor).toMatch(/^byte:/);
    const older = yield* store.readThread(fixture.threadId, {
      ...(newest.nextCursor === null ? {} : { beforeCursor: newest.nextCursor }),
      limit: 1,
    });
    expect(older.messages[0]?.text).toBe("x".repeat(160));
  }).pipe(
    Effect.provide(testLayer(fixture.home)),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(fixture.home, { recursive: true, force: true })),
    ),
  );
});

it.effect("groups automation runs by first-line name, including archived runs", () => {
  const home = makeFixture();
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "state_1.sqlite"));
  const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const id = (n: number) => `019e487f-4854-7902-8efb-${n.toString(16).padStart(12, "0")}`;
  insert.run(
    id(1),
    "Automation: Inbox\nAutomation ID: a",
    1,
    1000,
    1,
    1000,
    "first",
    "A:/Dev",
    1,
    "",
    "paginated",
    "automation",
  );
  insert.run(
    id(2),
    "Automation: Inbox\r\nAutomation ID: a",
    2,
    2000,
    3,
    3000,
    "latest",
    "A:/Dev",
    0,
    "",
    "paginated",
    "automation",
  );
  insert.run(
    id(3),
    "odd title",
    4,
    4000,
    4,
    4000,
    null,
    "A:/Dev",
    1,
    "",
    "paginated",
    "automation",
  );
  insert.run(
    id(4),
    "Automation:  \nAutomation ID: b",
    5,
    5000,
    5,
    5000,
    null,
    "A:/Dev",
    0,
    "",
    "paginated",
    "automation",
  );
  const longName = "x".repeat(159);
  insert.run(
    id(5),
    `Automation: ${longName} y`,
    6,
    6000,
    6,
    6000,
    null,
    "A:/Dev",
    0,
    "",
    "paginated",
    "automation",
  );
  db.close();
  const historyDb = new NodeSqlite.DatabaseSync(NodePath.join(home, "thread_history_1.sqlite"));
  historyDb
    .prepare("INSERT INTO thread_items VALUES (?,?,?,?,?,?)")
    .run(
      id(1),
      "archived-message",
      "agentMessage",
      JSON.stringify({ type: "agentMessage", text: "Archived result" }),
      1100,
      1,
    );
  historyDb.close();
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    const routines = yield* store.listScheduledRoutines();
    expect(routines.routines.map((routine) => [routine.name, routine.runCount])).toEqual([
      [longName, 1],
      ["Scheduled automation", 2],
      ["Inbox", 2],
    ]);
    expect(routines.routines[2]?.latestRun).toMatchObject({
      id: id(2),
      archived: false,
      preview: "latest",
    });
    const runs = yield* store.listScheduledRuns("Inbox");
    expect(runs.runs.map((run) => [run.id, run.archived])).toEqual([
      [id(2), false],
      [id(1), true],
    ]);
    const archived = yield* store.readScheduledRun(id(1));
    expect(archived.thread.id).toBe(id(1));
    expect(archived.messages.map((message) => message.text)).toEqual(["Archived result"]);
    const normalRead = yield* Effect.result(store.readThread(id(1)));
    expect(normalRead._tag).toBe("Failure");
    const nonAutomation = yield* Effect.result(store.readScheduledRun(threadId));
    expect(nonAutomation._tag).toBe("Failure");
  }).pipe(
    Effect.provide(testLayer(home)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
  );
});

it.effect("bounds routine and run pages, including empty and missing databases", () => {
  const home = makeFixture();
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "state_1.sqlite"));
  const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const id = (n: number) => `019e487f-4854-7902-8efb-${n.toString(16).padStart(12, "0")}`;
  for (let n = 1; n <= 56; n++) {
    insert.run(
      id(n),
      `Automation: Routine ${n}`,
      n,
      n * 1000,
      n,
      n * 1000,
      "x".repeat(300),
      "A:/Dev",
      n % 2,
      "",
      "paginated",
      "automation",
    );
  }
  for (let n = 57; n <= 84; n++) {
    insert.run(
      id(n),
      "Automation: Routine 1",
      n,
      n * 1000,
      n,
      n * 1000,
      "more",
      "A:/Dev",
      1,
      "",
      "paginated",
      "automation",
    );
  }
  db.close();
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    const first = yield* store.listScheduledRoutines();
    expect(first.routines).toHaveLength(50);
    expect(first.nextCursor).toBe("50");
    expect(
      first.routines.find((routine) => routine.name === "Routine 56")?.latestRun.preview,
    ).toHaveLength(240);
    const second = yield* store.listScheduledRoutines({ cursor: first.nextCursor! });
    expect(second.routines).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    const runs = yield* store.listScheduledRuns("Routine 1");
    expect(runs.runs).toHaveLength(25);
    expect(runs.nextCursor).toBe("25");
    const older = yield* store.listScheduledRuns("Routine 1", { cursor: runs.nextCursor! });
    expect(older.runs).toHaveLength(4);
    expect(older.nextCursor).toBeNull();
    expect((yield* store.listScheduledRuns("unknown")).runs).toEqual([]);
  }).pipe(
    Effect.provide(testLayer(home)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
  );
});

it.effect("returns empty scheduled lists when the Codex state database is absent", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-empty-"));
  const missingHome = NodePath.join(home, "not-created");
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    expect((yield* store.listScheduledRoutines()).routines).toEqual([]);
    expect((yield* store.listScheduledRuns("Inbox")).runs).toEqual([]);
    const missing = yield* Effect.gen(function* () {
      const missingStore = yield* CodexDesktopStore.CodexDesktopStore;
      return yield* missingStore.listScheduledRoutines();
    }).pipe(Effect.provide(testLayer(missingHome)));
    expect(missing.routines).toEqual([]);
  }).pipe(
    Effect.provide(testLayer(home)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
  );
});
