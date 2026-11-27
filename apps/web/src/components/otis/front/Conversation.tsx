import type { EnvironmentId, OtisFront } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useLayoutEffect, useRef, useState } from "react";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { FrontCard, type RunFrontAction } from "./FrontCard";
import { chicagoTime, retryText, sameSender } from "./front.logic";

export function Conversation({
  environmentId,
  items,
  loading,
  older,
  loadOlder,
  run,
  retry,
  disabled,
}: {
  environmentId: EnvironmentId;
  items: readonly OtisFront.ConversationItem[];
  loading: boolean;
  older: boolean;
  loadOlder: () => Promise<void>;
  run: RunFrontAction;
  retry: (text: string) => void;
  disabled: boolean;
}) {
  const gt = useGT();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const paging = useRef(false);
  const [newMessages, setNewMessages] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the external scroller pinned only while reading the latest items.
  useLayoutEffect(() => {
    const pane = scroller.current;
    if (!pane || !items.length || paging.current) return;
    if (pinned.current) pane.scrollTop = pane.scrollHeight;
    else setNewMessages(true);
  }, [items]);
  async function earlier() {
    const pane = scroller.current;
    if (!older || !pane || paging.current) return;
    paging.current = true;
    try {
      await loadOlder();
    } finally {
      paging.current = false;
    }
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const pane = event.currentTarget;
          pinned.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 80;
          if (pinned.current) setNewMessages(false);
          if (!pinned.current && pane.scrollTop <= 80) void earlier();
        }}
      >
        <div className="mx-auto max-w-[760px] px-3 py-3 text-sm leading-5">
          {older && (
            <Button size="sm" variant="ghost" onClick={() => void earlier()}>
              {gt("Earlier messages")}
            </Button>
          )}
          {loading && items.length === 0 && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}
          {items.map((item, index) => {
            const grouped = sameSender(items[index - 1], item);
            const sender =
              item.from === "jared"
                ? gt("You")
                : item.from === "otis-1"
                  ? gt("Otis #1")
                  : gt("Otis");
            const at = chicagoTime.format(new Date(item.at)).replace(/ [AP]M$/, "");
            const original = item.status === "failed" ? retryText(item, items) : undefined;
            return (
              <article
                key={item.id}
                className={`grid min-w-0 @sm:grid-cols-[44px_48px_minmax(0,1fr)] @sm:gap-x-2 ${grouped ? "mt-1.5" : "mt-3.5"}`}
              >
                <div className="hidden text-xs text-muted-foreground tabular-nums @sm:block">
                  {!grouped && at}
                  {item.channel === "voice" && item.from === "jared" && (
                    <span className="block">{gt("said")}</span>
                  )}
                </div>
                <div
                  className={`hidden text-xs @sm:block ${item.from === "jared" ? "text-muted-foreground" : ""}`}
                >
                  {!grouped && sender}
                </div>
                {!grouped && (
                  <div className="text-xs text-muted-foreground @sm:hidden">
                    {sender} · {at}
                    {item.channel === "voice" && item.from === "jared" && ` ${gt("said")}`}
                  </div>
                )}
                <div className="min-w-0 wrap-anywhere">
                  <div
                    data-front-item={item.id}
                    className={item.status === "failed" ? "text-destructive" : undefined}
                  >
                    {item.basis?.kind === "guess" && (
                      <span className="mr-1 text-muted-foreground">{gt("Guess")}</span>
                    )}
                    <ChatMarkdown
                      inline
                      text={item.text}
                      cwd={undefined}
                      environmentId={environmentId}
                      parseRawHtml={false}
                    />
                    {item.status === "streaming" && (
                      <span className="ml-1 text-muted-foreground">…</span>
                    )}
                    {item.status === "interrupted" && (
                      <span className="text-muted-foreground"> {gt("(stopped)")}</span>
                    )}
                    {original && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => retry(original)}
                      >
                        {gt("Try again")}
                      </Button>
                    )}
                  </div>
                  {item.cards.length > 0 && (
                    <div className="mt-1.5 space-y-1.5">
                      {item.cards.map((card) => (
                        <FrontCard key={card.id} card={card} run={run} disabled={disabled} />
                      ))}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {newMessages && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const pane = scroller.current;
              if (pane) {
                pinned.current = true;
                pane.scrollTop = pane.scrollHeight;
                setNewMessages(false);
              }
            }}
          >
            {gt("New messages")}
          </Button>
        </div>
      )}
    </div>
  );
}
