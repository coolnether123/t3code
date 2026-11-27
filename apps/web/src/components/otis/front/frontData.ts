import {
  createEnvironmentRpcCommand,
  runStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OtisFront, OtisFrontUpdate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { subscribeOtisFront } from "~/rpc/otisFront";

export const frontCommands = {
  turn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    tag: "otis.front.turn",
    label: "otis-front:turn",
  }),
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    tag: "otis.front.cancel",
    label: "otis-front:cancel",
  }),
  action: createEnvironmentRpcCommand(connectionAtomRuntime, {
    tag: "otis.front.action",
    label: "otis-front:action",
  }),
  history: createEnvironmentRpcCommand(connectionAtomRuntime, {
    tag: "otis.front.history",
    label: "otis-front:history",
  }),
  report: createEnvironmentRpcCommand(connectionAtomRuntime, {
    tag: "otis.front.report",
    label: "otis-front:report",
  }),
  heard: createEnvironmentRpcCommand(connectionAtomRuntime, {
    tag: "otis.front.heard",
    label: "otis-front:heard",
  }),
};

export function followFront(
  environmentId: EnvironmentId,
  after: () => number | undefined,
  onEvent: (event: OtisFrontUpdate) => void,
  signal: AbortSignal,
) {
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        runStreamInEnvironment(environmentId, subscribeOtisFront(after)).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
          Effect.provide(context),
        ),
      ),
    ),
    { signal },
  );
}

export function mergeHistory(
  items: ReadonlyMap<string, OtisFront.ConversationItem>,
  history: readonly OtisFront.ConversationItem[],
) {
  const next = new Map(items);
  for (const item of history) if (!next.has(item.id)) next.set(item.id, item);
  return next;
}

export function applyConversationEvent(
  items: ReadonlyMap<string, OtisFront.ConversationItem>,
  event: OtisFrontUpdate,
) {
  if (event.type === "reset") return new Map<string, OtisFront.ConversationItem>();
  if (event.type === "item") return new Map(items).set(event.item.id, event.item);
  if (event.type !== "reply.delta") return items;
  const item = items.get(event.itemId);
  return item?.status === "streaming"
    ? new Map(items).set(item.id, { ...item, text: item.text + event.text })
    : items;
}
