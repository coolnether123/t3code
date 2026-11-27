import { useAtomValue } from "@effect/atom-react";
import { readOtisTree, settledChildren } from "@t3tools/client-runtime/rpc/otis-history";
import { runStreamInEnvironment } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OtisAction, OtisNode, OtisTreeRead } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { createOtisTreeAtoms } from "@t3tools/client-runtime/state/otis-tree";
import { offlineFleet } from "@t3tools/client-runtime/otis/tree";

const { tree, act, usage: otisLaneUsage } = createOtisTreeAtoms(connectionAtomRuntime);
export { otisLaneUsage };
const fleet = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (!environmentId) return offlineFleet;
  const result = get(tree({ environmentId, input: {} }));
  return AsyncResult.isSuccess(result) ? result.value : offlineFleet;
});

export function useFleet() {
  return useAtomValue(fleet);
}

export function readFleet() {
  return appAtomRegistry.get(fleet);
}

export function runFleetAction(environmentId: EnvironmentId, input: OtisAction) {
  return Effect.runPromise(act.run(appAtomRegistry, { environmentId, input }));
}

export interface DonePage {
  readonly nodes: readonly OtisNode[];
  readonly next: string | null;
}

export async function readDonePage(
  environmentId: EnvironmentId,
  parent: string,
  before: string | null,
  signal: AbortSignal,
): Promise<DonePage> {
  const result = await firstTreeRead(environmentId, settledChildren(parent, before), signal);
  if (!result || !("next" in result)) throw new Error("Done chats unavailable");
  return result;
}

export async function readWorkerNodes(
  environmentId: EnvironmentId,
  read: Extract<OtisTreeRead, { nodeId: string } | { featuredWorkers: true }>,
  signal: AbortSignal,
) {
  const result = await firstTreeRead(environmentId, readOtisTree(read), signal);
  return result?.nodes ?? [];
}

async function firstTreeRead(
  environmentId: EnvironmentId,
  stream: ReturnType<typeof readOtisTree>,
  signal: AbortSignal,
) {
  const response = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        runStreamInEnvironment(environmentId, stream).pipe(Stream.runHead, Effect.provide(context)),
      ),
    ),
    { signal },
  );
  const frame = Option.getOrNull(response);
  return frame?.type === "read" ? frame.result : null;
}
