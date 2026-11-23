import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Effect from "effect/Effect";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";

// Follow the current environment session. Each new socket starts with the bridge's live snapshot.
export const subscribeFleet = Stream.unwrap(
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.map((supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.make({ type: "unavailable" } as const),
            onSome: (session) =>
              session.client["otis.subscribe"]({}).pipe(
                Stream.filter((event) => event.type !== "read"),
              ),
          }),
        ),
      ),
    ),
  ),
);
