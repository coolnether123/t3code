import type { OtisFrontUpdate } from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export function subscribeOtisFront(
  after: () => number | undefined,
): Stream.Stream<OtisFrontUpdate, never, EnvironmentSupervisor.EnvironmentSupervisor> {
  const unavailable = Stream.make({ type: "unavailable" } as const);
  return Stream.unwrap(
    EnvironmentSupervisor.EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => unavailable,
              onSome: (session) => {
                const cursor = after();
                // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- This RPC boundary follows session changes; the server enforces the read scope before opening each stream.
                return session.client["otis.front.subscribe"](
                  cursor === undefined ? {} : { after: cursor },
                ).pipe(Stream.catch(() => unavailable));
              },
            }),
          ),
        ),
      ),
    ),
  );
}
