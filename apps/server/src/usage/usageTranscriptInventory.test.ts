// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) };
});

import { listTranscriptFilesBounded } from "./usageTranscriptReader.ts";

describe("bounded inventory ownership", () => {
  for (const blockedOperation of ["readdir", "stat"]) {
    it.effect(
      `preserves partial coverage while cancelled ${blockedOperation} still owns its batch`,
      () =>
        Effect.gen(function* () {
          const root = NodePath.resolve(`/synthetic-${blockedOperation}-home`);
          const rollout = NodePath.join(root, "rollout.jsonl");
          let nowMs = 0;
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let directoryReads = 0;
          let metadataReads = 0;
          vi.mocked(NodeFSP.readdir).mockImplementation((async () => {
            directoryReads += 1;
            if (blockedOperation === "readdir" && directoryReads === 1) {
              entered.resolve();
              await release.promise;
            }
            return [{ name: "rollout.jsonl", isDirectory: () => false }];
          }) as unknown as typeof NodeFSP.readdir);
          vi.mocked(NodeFSP.stat).mockImplementation((async () => {
            metadataReads += 1;
            if (blockedOperation === "stat" && metadataReads === 1) {
              entered.resolve();
              await release.promise;
            }
            return { size: 3, mtimeMs: 10 };
          }) as unknown as typeof NodeFSP.stat);
          const admission = yield* Semaphore.make(1);
          let abandoned!: ReturnType<typeof listTranscriptFilesBounded>;
          const first = yield* admission
            .withPermits(1)(
              Effect.promise(() => {
                abandoned = listTranscriptFilesBounded(root, 0, "codex", 2_000, () => nowMs);
                return abandoned;
              }),
            )
            .pipe(Effect.forkChild);
          try {
            yield* Effect.promise(() => entered.promise);
            nowMs = 15_000;
            yield* Fiber.interrupt(first);
            const retry = yield* admission.withPermits(1)(
              Effect.promise(() =>
                listTranscriptFilesBounded(root, 0, "codex", 2_000, () => nowMs),
              ),
            );
            expect(retry).toEqual({ files: [], complete: false });
            expect(directoryReads).toBe(1);
            release.resolve();
            expect((yield* Effect.promise(() => abandoned)).complete).toBe(false);
            const complete = yield* Effect.promise(() =>
              listTranscriptFilesBounded(root, 0, "codex", 2_000, () => nowMs),
            );
            expect(complete).toEqual({
              files: [{ path: rollout, size: 3, mtimeMs: 10 }],
              complete: true,
            });
            expect(directoryReads).toBe(1);
            expect(metadataReads).toBe(1);
          } finally {
            release.resolve();
            yield* Fiber.interrupt(first);
            yield* Effect.promise(() => abandoned);
            vi.restoreAllMocks();
          }
        }),
    );
  }
});
