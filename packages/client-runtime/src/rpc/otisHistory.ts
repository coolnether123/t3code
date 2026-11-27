import type { OtisTreeRead } from "@t3tools/contracts";
import { currentSession } from "./client.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export function settledChildren(parent: string, before: string | null) {
  return readOtisTree({ parent, settled: true, ...(before ? { before } : {}) });
}

export function readOtisTree(read: OtisTreeRead) {
  return Stream.unwrap(
    currentSession().pipe(Effect.map((session) => session.client["otis.subscribe"]({ read }))),
  );
}
