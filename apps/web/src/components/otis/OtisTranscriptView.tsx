import { Link } from "@tanstack/react-router";
import { EnvironmentId as EnvId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useGT } from "gt-react";
import type { EnvironmentId, OtisTailInput, OtisTailPage } from "@t3tools/contracts";
import { createOtisTreeAtoms } from "@t3tools/client-runtime/state/otis-tree";
import * as Effect from "effect/Effect";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "../ui/button";
import * as Schema from "effect/Schema";
import { writeLocalStorageValue } from "~/hooks/useLocalStorage";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useFleet } from "./sidebar/fleetData";

const { tail } = createOtisTreeAtoms(connectionAtomRuntime);

function readPage(environmentId: EnvironmentId, input: OtisTailInput, signal?: AbortSignal) {
  return Effect.runPromise(
    tail.run(appAtomRegistry, { environmentId, input }),
    signal ? { signal } : undefined,
  );
}

export function OtisTranscriptView({ nodeId }: { nodeId: string }) {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const { nodes, sidebar } = useFleet();
  const { setOpen, setOpenMobile, isMobile } = useSidebar();
  const node = nodes.get(nodeId);
  const [lastNode, setLastNode] = useState(node);
  if (node && node !== lastNode) setLastNode(node);
  const shownNode = node ?? (lastNode?.id === nodeId ? lastNode : undefined);
  const chat = shownNode?.chat;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <h1 className="min-w-0 truncate text-sm font-medium">
          {shownNode?.title ?? gt("Chat transcript")}
        </h1>
        {chat?.host === "t3" && (
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(
              scopeThreadRef(EnvId.make(chat.environmentId), ThreadId.make(chat.threadId)),
            )}
          >
            {gt("Open chat")}
          </Link>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{gt("Read only")}</span>
      </WorkspacePageHeader>
      {environmentId && (
        <Transcript
          key={JSON.stringify([environmentId, nodeId, shownNode?.chat?.threadId ?? null])}
          environmentId={environmentId}
          nodeId={nodeId}
          chooseChat={
            chat?.host === "t3"
              ? undefined
              : () => {
                  writeLocalStorageValue("otis.fleet.otherChats", true, false, Schema.Boolean);
                  if (isMobile) setOpenMobile(true);
                  else setOpen(true);
                }
          }
          tailSeq={shownNode?.tailSeq ?? 0}
          settled={sidebar === "otis" && node === undefined && lastNode !== undefined}
        />
      )}
    </SidebarInset>
  );
}

function Transcript({
  environmentId,
  nodeId,
  tailSeq,
  chooseChat,
  settled,
}: {
  environmentId: EnvironmentId;
  nodeId: string;
  chooseChat: (() => void) | undefined;
  tailSeq: number;
  settled: boolean;
}) {
  const gt = useGT();
  const [items, setItems] = useState<OtisTailPage["items"] | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const newest = useRef<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef<{ fromBottom: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tree watermarks drive incremental reads; leaving the route cancels applying late results.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function follow() {
      try {
        if (retry > 0 && !signal.aborted) setError(null);
        if (newest.current === null) {
          const page = await readPage(environmentId, { nodeId }, signal);
          if (signal.aborted) return;
          newest.current = page.items.at(-1)?.seq ?? 0;
          position.current = { fromBottom: 0 };
          setItems(page.items);
          setPrev(page.prev);
        }
        // A settled node leaves the live tree. Read any final output ahead of its last watermark.
        let more = settled || tailSeq > newest.current;
        while (more) {
          const after = newest.current;
          const page = await readPage(environmentId, { nodeId, after }, signal);
          if (signal.aborted) return;
          const last = page.items.at(-1)?.seq;
          if (last === undefined || last <= after) break;
          newest.current = last;
          const el = scroll.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
            position.current = { fromBottom: 0 };
          }
          setItems((current) => [...(current ?? []), ...page.items]);
          more = !page.end && (settled || tailSeq > newest.current);
        }
        if (!signal.aborted) setError(null);
      } catch (cause) {
        if (!signal.aborted)
          setError(
            cause instanceof Error ? cause.message : gt("Otis did not return a transcript."),
          );
      }
    }
    void follow();
    return () => controller.abort();
  }, [environmentId, nodeId, tailSeq, settled, retry, gt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Preserve the DOM scroll anchor when a page changes the transcript height.
  useLayoutEffect(() => {
    const el = scroll.current;
    if (items !== null && el && position.current) {
      el.scrollTop = el.scrollHeight - el.clientHeight - position.current.fromBottom;
      position.current = null;
    }
  }, [items]);

  async function older() {
    if (prev === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await readPage(environmentId, { nodeId, before: prev });
      const el = scroll.current;
      if (el) position.current = { fromBottom: el.scrollHeight - el.clientHeight - el.scrollTop };
      setItems((current) => [...page.items, ...(current ?? [])]);
      setPrev(page.prev);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : gt("Otis did not return the earlier messages."),
      );
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div
      ref={scroll}
      className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      onScroll={(event) => {
        if (event.currentTarget.scrollTop === 0 && !error) void older();
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6">
        {prev !== null && (
          <div className="self-center">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingOlder}
              onClick={() => void older()}
            >
              {gt("Load earlier messages")}
            </Button>
          </div>
        )}
        {items === null && !error && <p role="status">{gt("Loading transcript…")}</p>}
        {items?.length === 0 && !error && <p role="status">{gt("No messages yet.")}</p>}
        {items?.map((item) =>
          item.tool ? (
            <p key={item.seq} className="text-xs text-muted-foreground">
              {gt("Called {name}", { name: item.tool.name })}
            </p>
          ) : (
            <article key={item.seq} className="rounded-lg border px-4 py-3">
              <h2 className="mb-1 text-xs font-medium text-muted-foreground">
                {item.from === "parent"
                  ? gt("Parent")
                  : item.role === "user"
                    ? gt("You")
                    : item.role === "assistant"
                      ? gt("Assistant")
                      : gt("System")}
              </h2>
              <p className="text-sm wrap-anywhere whitespace-pre-wrap">
                {item.text}
                {item.cut && "…"}
              </p>
            </article>
          ),
        )}
        {error && (
          <div className="flex items-center gap-2">
            <p role="status">
              {gt("Could not load the transcript.")} {error}
            </p>
            <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
              {gt("Retry")}
            </Button>
            {chooseChat && (
              <Button variant="outline" size="sm" onClick={chooseChat}>
                {gt("Open chat")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
