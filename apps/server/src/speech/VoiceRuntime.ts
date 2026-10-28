import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Auxiliary from "../provider/AuxiliaryProviderSessions.ts";
import * as VoiceThreadService from "./VoiceThreadService.ts";
import { callOperator } from "./callOperator.ts";
import { CallReplyBuffer } from "./operatorProtocol.ts";
import { HoldTurnGuard } from "./hold.ts";
import { lookupVoiceAgenda } from "./voiceLookups.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const config = yield* ServerConfig.ServerConfig;
    const sessions = yield* Auxiliary.AuxiliaryProviderSessions;
    const threads = yield* VoiceThreadService.VoiceThreadService;
    const calls = callOperator(config.stateDir);
    const replies = new CallReplyBuffer();
    const holds = new HoldTurnGuard();
    calls.bind({
      context: (threadId) => runPromise(threads.context(threadId)),
      start: (input) =>
        runPromise(
          Effect.gen(function* () {
            const link = yield* Effect.promise(() => calls.findLink(input.threadId));
            return yield* sessions.startSession(
              input.threadId,
              input,
              link?.role === "operator" ? ThreadId.make(link.threadId) : undefined,
            );
          }),
        ),
      send: (input) => runPromise(sessions.sendTurn(input)),
      sessions: () => runPromise(sessions.listSessions()),
      dispatch: (command) => runPromise(threads.dispatch(command)),
      lookup: lookupVoiceAgenda,
    });
    yield* sessions.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const reply = replies.accept(event);
          const owner = yield* Effect.promise(() => calls.findLink(event.threadId));
          const accepted =
            owner?.role === "voice" ? holds.accept(event, reply.raw) : { event, stop: false };
          if (!accepted) return;
          const next = accepted.event;
          const link = yield* Effect.tryPromise(() => calls.event(next, reply.raw));
          if (
            link?.role === "voice" &&
            (event.type === "turn.started" ||
              event.type === "content.delta" ||
              event.type === "item.completed" ||
              event.type === "turn.completed" ||
              event.type === "runtime.error")
          )
            yield* threads.recordVoiceEvent(link, next, reply.raw);
          if (accepted.stop) {
            replies.accept(next);
            yield* sessions.stopSession({ threadId: event.threadId }).pipe(Effect.forkScoped);
          }
          if ("pending" in accepted && accepted.pending) {
            // Wait for the assistant item boundary so a chunked legacy delegation can continue.
            // A missing boundary must not leave a pure hold streaming until the provider timeout.
            yield* Effect.gen(function* () {
              yield* Effect.sleep(5_000);
              const expired = holds.expire(event);
              if (!expired) return;
              const link = yield* Effect.tryPromise(() => calls.event(expired.event, reply.raw));
              if (link?.role === "voice")
                yield* threads.recordVoiceEvent(link, expired.event, reply.raw);
              replies.accept(expired.event);
              yield* sessions.stopSession({ threadId: event.threadId });
            }).pipe(
              Effect.catch((cause) =>
                Effect.logError("Silent voice hold completion failed", cause),
              ),
              Effect.forkScoped,
            );
          }
        }).pipe(Effect.catch((cause) => Effect.logError("Voice session event failed", cause))),
      ),
      Effect.forkScoped,
    );
    yield* sessions.streamAdapterEvents.pipe(
      Stream.runForEach(({ threadId, event }) =>
        Effect.gen(function* () {
          const link = yield* Effect.promise(() => calls.findLink(threadId));
          if (link?.role === "operator") yield* threads.recordOperatorEvent(link, event);
        }).pipe(Effect.catch((cause) => Effect.logError("Background call event failed", cause))),
      ),
      Effect.forkScoped,
    );
  }),
);
