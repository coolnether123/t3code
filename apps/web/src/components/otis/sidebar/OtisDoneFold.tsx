import { FleetTitle } from "./FleetTitle";
import { useGT } from "gt-react";
import type { EnvironmentId, OtisNode } from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { type DonePage, readDonePage } from "./fleetData";

interface PageProps {
  environmentId: EnvironmentId;
  parent: string;
  onOpen: (node: OtisNode) => void;
}
function useDonePage(
  environmentId: EnvironmentId,
  parent: string,
  before: string | null,
  summaryOnly: boolean,
) {
  const [result, setResult] = useState<{ count: number; page: DonePage } | "error" | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel the history RPC when the fold, cursor or environment changes.
  useEffect(() => {
    const controller = new AbortController();
    void readDonePage(environmentId, parent, before, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted)
          setResult({
            count: page.nodes.length,
            page: summaryOnly ? { nodes: [], next: page.next } : page,
          });
      },
      () => {
        if (!controller.signal.aborted) setResult("error");
      },
    );
    return () => controller.abort();
  }, [environmentId, parent, before, summaryOnly]);
  return result;
}

function HistoryPage({
  environmentId,
  parent,
  before,
  onOpen,
}: PageProps & { before: string | null }) {
  const gt = useGT();
  const result = useDonePage(environmentId, parent, before, false);
  const [more, setMore] = useState(false);
  if (!result)
    return (
      <p role="status" className="px-3 text-xs">
        {gt("Loading done chats…")}
      </p>
    );
  if (result === "error")
    return <p role="status">{gt("Could not load done chats. Reopen Done to try again.")}</p>;
  return (
    <>
      {result.page.nodes.map((node) =>
        node.chat ? (
          <button data-fleet-link="" key={node.id} onClick={() => onOpen(node)}>
            <FleetTitle title={node.title} />
          </button>
        ) : (
          <div key={node.id} className="truncate px-3 py-1 text-muted-foreground">
            <FleetTitle title={node.title} />
          </div>
        ),
      )}
      {result.page.next &&
        (more ? (
          <HistoryPage
            environmentId={environmentId}
            parent={parent}
            before={result.page.next}
            onOpen={onOpen}
          />
        ) : (
          <button data-fleet-link="" onClick={() => setMore(true)}>
            {gt("Show more")}
          </button>
        ))}
    </>
  );
}

export function OtisDoneFold({
  environmentId,
  parent,
  onOpen,
  depth,
}: PageProps & { depth: number }) {
  const [open, setOpen] = useState(false);
  const gt = useGT();
  const result = useDonePage(environmentId, parent, null, true);
  if (result && result !== "error" && !result.count) return null;
  const count =
    result && result !== "error" ? ` · ${result.count}${result.page.next ? "+" : ""}` : "";
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div style={{ paddingInlineStart: Math.min(depth, 4) * 12 }}>
      <button
        data-fleet-link=""
        className="text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron size={14} />
        {gt("Done")}
        {count}
      </button>
      {open && (
        <HistoryPage environmentId={environmentId} parent={parent} before={null} onOpen={onOpen} />
      )}
    </div>
  );
}
