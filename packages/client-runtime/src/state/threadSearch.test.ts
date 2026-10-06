// @effect-diagnostics globalDate:off - Assert local calendar-day conversion.
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  threadSearchMatchKey,
  chatHistoryDateInput,
  mergeChatHistoryMatches,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

it("uses inclusive local calendar days and rejects invalid or reversed dates", () => {
  const input = chatHistoryDateInput(" needle ", "2026-10-06", "2026-10-06");
  expect(input.query).toBe("needle");
  expect(input.from).toBe(new Date("2026-10-06T00:00:00").toISOString());
  expect(input.before).toBe(new Date("2026-10-07T00:00:00").toISOString());
  expect(() => chatHistoryDateInput("", "2026-02-30", "")).toThrow();
  expect(() => chatHistoryDateInput("", "2026-10-07", "2026-10-06")).toThrow();
  expect(() => chatHistoryDateInput("", "10/06/2026", "")).toThrow();
});

it("deduplicates linked T3 and Codex matches while preserving unrelated identical IDs", () => {
  const t3 = {
    source: "t3" as const,
    threadId: "t3-a",
    codexThreadId: "native-a",
    title: "T3",
    updatedAt: "2026-10-06T00:00:00.000Z",
    archived: false,
    snippet: "needle",
  };
  const native = { ...t3, source: "codex-app" as const, threadId: "native-a", title: "Codex" };
  const unrelated = { ...t3, threadId: "native-a", codexThreadId: null };
  expect(mergeChatHistoryMatches([t3], [native, native, unrelated])).toEqual([native, unrelated]);
  expect(mergeChatHistoryMatches([native], [t3])).toEqual([native]);
});

it("creates stable keys regardless of environment order", () => {
  expect(makeThreadSearchKey([envB, envA], "needle")).toBe(
    makeThreadSearchKey([envA, envB], "needle"),
  );
});

it("creates keys without array methods unavailable in Hermes", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Reflect.deleteProperty(Array.prototype, "toSorted");

  try {
    expect(makeThreadSearchKey([envB, envA], "needle")).toBe('[["env-a","env-b"],"needle"]');
  } finally {
    if (descriptor !== undefined) {
      Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
});

it("encodes scoped thread keys without delimiter collisions", () => {
  const first = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env\u0000thread"),
    threadId: ThreadId.make("id"),
  });
  const second = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread\u0000id"),
  });

  expect(first).not.toBe(second);
});

it("accepts search keys at the maximum decoded query length", () => {
  const queries: string[] = [];
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (_environmentId, query) => {
      queries.push(query);
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();
  const query = "a".repeat(200);

  try {
    registry.get(searchAtom(makeThreadSearchKey([envA], query)));
    registry.get(searchAtom(makeThreadSearchKey([envA], ` ${query} `)));

    expect(queries).toEqual([query, query]);
  } finally {
    registry.dispose();
  }
});

it("ignores invalid search keys", () => {
  let searchCount = 0;
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: () => {
      searchCount += 1;
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  try {
    const state = registry.get(searchAtom(makeThreadSearchKey([envA], "a".repeat(201))));
    const malformedState = registry.get(searchAtom("not json{{"));

    expect(state).toEqual({ matches: [], isLoading: false });
    expect(malformedState).toEqual({ matches: [], isLoading: false });
    expect(searchCount).toBe(0);
  } finally {
    registry.dispose();
  }
});

it("merges successful environments and silently ignores failures", () => {
  const result: OrchestrationSearchThreadsResult = {
    matches: [
      {
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        source: "user",
        snippet: "needle",
        messageCreatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  };
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (environmentId) =>
      environmentId === envA
        ? Atom.make(AsyncResult.success(result))
        : Atom.make(
            AsyncResult.failure<OrchestrationSearchThreadsResult, Error>(
              Cause.fail(new Error("unsupported rpc")),
            ),
          ),
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  const state = registry.get(searchAtom(makeThreadSearchKey([envB, envA], "needle")));
  expect(state).toEqual({
    matches: [{ ...result.matches[0], environmentId: envA }],
    isLoading: false,
  });
  expect(threadSearchMatchKey(state.matches[0]!)).toBe('["env-a","thread-a"]');

  registry.dispose();
});
