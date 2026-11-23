import type { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { applyFleetEvent, offlineFleet } from "../otis/tree.ts";
import { subscribeFleet } from "../rpc/otis.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export function createOtisTreeAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    tree: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:otis:tree",
      subscribe: (_input: Record<string, never>) =>
        subscribeFleet.pipe(Stream.scan(() => offlineFleet, applyFleetEvent)),
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:otis:act",
      tag: "otis.act",
    }),
    tail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:otis:tail",
      tag: "otis.nodeTail",
    }),
  };
}
