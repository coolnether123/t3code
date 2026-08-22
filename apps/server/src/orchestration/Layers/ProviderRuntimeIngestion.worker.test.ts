import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runNormalProviderRuntimeEvent } from "./ProviderRuntimeIngestion.ts";

const event = (threadId: ThreadId): ProviderRuntimeEvent => ({
  type: "runtime.warning",
  eventId: EventId.make(`event-${threadId}`),
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-22T00:00:00.000Z",
  threadId,
  payload: { message: "test event" },
});

it.effect("bypasses normal projection for an explicitly linked Worker thread", () =>
  Effect.gen(function* () {
    let projected = false;
    yield* runNormalProviderRuntimeEvent(
      () => Effect.succeed(true),
      event(ThreadId.make("provider-worker-thread")),
      () =>
        Effect.sync(() => {
          projected = true;
        }),
    );
    expect(projected).toBe(false);
  }),
);

it.effect("continues normal projection for an ordinary provider thread", () =>
  Effect.gen(function* () {
    let projected = false;
    yield* runNormalProviderRuntimeEvent(
      () => Effect.succeed(false),
      event(ThreadId.make("ordinary-parent-thread")),
      () =>
        Effect.sync(() => {
          projected = true;
        }),
    );
    expect(projected).toBe(true);
  }),
);
