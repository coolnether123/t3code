import {
  AgentBrowserLeaseList,
  type AgentBrowserLease,
  type EnvironmentId,
} from "@t3tools/contracts";
import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { readPreviewStreamAccess } from "~/state/previewStream";

const EMPTY_LEASES: ReadonlyArray<AgentBrowserLease> = [];
const decodeLeases = Schema.decodeUnknownSync(AgentBrowserLeaseList);
const stores = new Map<EnvironmentId, ReturnType<typeof createLeaseStore>>();

function createLeaseStore(environmentId: EnvironmentId) {
  let leases = EMPTY_LEASES;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  let generation = 0;
  let refreshAccess = false;
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyArray<AgentBrowserLease>) => {
    if (JSON.stringify(leases) === JSON.stringify(next)) return;
    leases = next;
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    const current = generation;
    try {
      if (!document.hidden) {
        const access = await readPreviewStreamAccess(environmentId, refreshAccess);
        refreshAccess = false;
        if (current !== generation) return;
        if (!access) {
          refreshAccess = true;
          throw new Error("Browser view unavailable");
        }
        request = new AbortController();
        const response = await fetch(withDeviceHubQuery(`${access.httpBase}/leases`, access), {
          credentials: access.credentials ? "include" : "omit",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]),
          cache: "no-store",
        });
        if (!response.ok) {
          refreshAccess = response.status === 401 || response.status === 403;
          throw new Error("Browser view unavailable");
        }
        const result = decodeLeases(await response.json());
        if (current === generation) publish(result.leases);
      }
    } catch {
      if (current === generation) publish(EMPTY_LEASES);
    } finally {
      if (current === generation && listeners.size > 0) {
        request = null;
        timer = setTimeout(() => void refresh(), 3_000);
      }
    }
  };
  return {
    snapshot: () => leases,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        generation++;
        request?.abort();
        if (timer !== null) clearTimeout(timer);
        timer = null;
        leases = EMPTY_LEASES;
      };
    },
  };
}

export function useAgentBrowserLeases(environmentId: EnvironmentId) {
  let store = stores.get(environmentId);
  if (!store) {
    store = createLeaseStore(environmentId);
    stores.set(environmentId, store);
  }
  return useSyncExternalStore(store.subscribe, store.snapshot, () => EMPTY_LEASES);
}
