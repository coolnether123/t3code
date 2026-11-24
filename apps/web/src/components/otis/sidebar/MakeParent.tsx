import { type EnvironmentId, type ThreadId, type OtisNode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { writeLocalStorageValue } from "~/hooks/useLocalStorage";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useGT } from "gt-react";
import { randomUUID } from "~/lib/utils";
import { useEffect, useState, useSyncExternalStore } from "react";
import { runFleetAction, useFleet } from "./fleetData";

type PendingParent = { environmentId: EnvironmentId; threadId: ThreadId; title: string };
let pending: readonly PendingParent[] = [];
const listeners = new Set<() => void>();
function publish(rows: readonly PendingParent[]) {
  pending = rows;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useConnectingParents(nodes?: ReadonlyMap<string, OtisNode>) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retire pending registry entries when the fleet stream confirms their bindings.
  useEffect(() => {
    if (!nodes || !pending.length) return;
    const roots = [...nodes.values()].filter((node) => node.kind === "lane");
    const remaining = pending.filter(
      (row) =>
        !roots.some(
          ({ chat }) =>
            chat?.host === "t3" &&
            chat.threadId === row.threadId &&
            chat.environmentId === row.environmentId,
        ),
    );
    if (remaining.length !== pending.length) publish(remaining);
  }, [nodes]);
  return useSyncExternalStore(subscribe, () => pending);
}
export function MakeParent({ environmentId, threadId }: Omit<PendingParent, "title">) {
  const gt = useGT();
  const fleet = useFleet();
  const primary = usePrimaryEnvironmentId();
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rows = useConnectingParents();
  const busy = rows.some((row) => row.environmentId === environmentId && row.threadId === threadId);
  if (
    environmentId !== primary ||
    fleet.sidebar !== "otis" ||
    [...fleet.nodes.values()].some(
      (node) =>
        node.kind === "lane" &&
        node.chat?.host === "t3" &&
        node.chat.environmentId === environmentId &&
        node.chat.threadId === threadId,
    )
  )
    return null;
  async function bind() {
    const title = name?.trim();
    if (!title || busy) return;
    const row = { environmentId, threadId, title };
    publish([...pending, row]);
    writeLocalStorageValue("otis.fleet.otherChats", false, false, Schema.Boolean);
    setError("");
    try {
      await runFleetAction(environmentId, {
        type: "parent.bind",
        title,
        threadId,
        requestId: randomUUID(),
      });
      setName(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not bind this parent."));
      publish(pending.filter((value) => value !== row));
    }
  }
  return (
    <div className="relative shrink-0 text-xs">
      <button type="button" onClick={() => setName(name === null ? "" : null)}>
        {gt("Make parent")}
      </button>
      {name !== null && (
        <form
          className="absolute right-0 z-50 grid w-56 gap-2 rounded border bg-popover p-3 shadow"
          onSubmit={(event) => {
            event.preventDefault();
            void bind();
          }}
        >
          <label>
            {gt("Parent name")}
            <input
              autoFocus
              required
              maxLength={120}
              className="w-full rounded border p-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? gt("Connecting…") : gt("Make parent")}
          </button>
        </form>
      )}
    </div>
  );
}
