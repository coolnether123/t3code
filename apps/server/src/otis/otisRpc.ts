import type { OtisTreeRead } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as OtisBridge from "./OtisBridge.ts";

export const otisRpcHandlers = Effect.gen(function* () {
  const bridge = yield* OtisBridge.OtisBridge;
  return {
    "otis.subscribe": ({ read }: { readonly read?: OtisTreeRead }) =>
      read === undefined
        ? bridge.subscribe
        : Stream.fromEffect(
            bridge.read(read).pipe(Effect.map((result) => ({ type: "read" as const, result }))),
          ),
    "otis.act": bridge.act,
    "otis.nodeTail": bridge.tail,
  };
});
