import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Auxiliary from "../provider/AuxiliaryProviderSessions.ts";
import * as VoiceThreadService from "./VoiceThreadService.ts";
import { callOperator } from "./callOperator.ts";
import { CallReplyBuffer } from "./operatorProtocol.ts";
import { lookupVoiceAgenda } from "./voiceLookups.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const sessions = yield* Auxiliary.AuxiliaryProviderSessions;
    const threads = yield* VoiceThreadService.VoiceThreadService;
    const calls = callOperator(config.stateDir);
    const replies = new CallReplyBuffer();
    calls.bind({
      context: (threadId) => Effect.runPromise(threads.context(threadId)),
      start: (input) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const link = yield* Effect.promise(() => calls.findLink(input.threadId));
            return yield* sessions.startSession(
              input.threadId,
              input,
              link?.role === "operator" ? ThreadId.make(link.threadId) : undefined,
            );
          }),
        ),
      send: (input) => Effect.runPromise(sessions.sendTurn(input)),
      sessions: () => Effect.runPromise(sessions.listSessions()),
      dispatch: (command) => Effect.runPromise(threads.dispatch(command)),
      lookup: lookupVoiceAgenda,
    });
    yield* sessions.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const reply = replies.accept(event);
          const link = yield* Effect.tryPromise(() => calls.event(event, reply.raw));
          if (
            link?.role === "voice" &&
            (event.type === "turn.started" ||
              event.type === "content.delta" ||
              event.type === "item.completed" ||
              event.type === "turn.completed" ||
              event.type === "runtime.error")
          )
            yield* threads.recordVoiceEvent(link, event, reply.raw);
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
