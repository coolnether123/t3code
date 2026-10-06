import { useEffect, useState, useRef } from "react";
import {
  CHAT_HISTORY_MESSAGE_PAGE_SIZE,
  type ChatHistoryMatch,
  type ChatHistorySearchInput,
  type ChatHistorySearchResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  chatHistoryDateInput,
  mergeChatHistoryMatches,
  advanceChatHistoryScan,
  INITIAL_CHAT_HISTORY_SCAN,
} from "@t3tools/client-runtime/state/thread-search";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";

type Computer = { environmentId: EnvironmentId; label: string };
export const CHAT_HISTORY_SEARCH_EVENT = "t3code:open-chat-history-search";

function ComputerResults({
  computer,
  input,
  onOpen,
}: {
  computer: Computer;
  input: ChatHistorySearchInput;
  onOpen: (match: ChatHistoryMatch, computer: Computer) => void;
}) {
  const [scan, setScan] = useState(INITIAL_CHAT_HISTORY_SCAN);
  const [paused, setPaused] = useState(false);
  const consumedPage = useRef<ChatHistorySearchResult | null>(null);
  const [t3Offset, setT3Offset] = useState(0);
  const [previous, setPrevious] = useState<ReadonlyArray<ChatHistoryMatch>>([]);
  const search = useEnvironmentQuery(
    orchestrationEnvironment.chatHistorySearch({
      environmentId: computer.environmentId,
      input: { ...input, t3Offset, ...(scan.codexCursor ? { codexCursor: scan.codexCursor } : {}) },
    }),
  );
  useEffect(() => {
    if (
      search.isPending ||
      !search.data ||
      paused ||
      scan.done ||
      consumedPage.current === search.data
    )
      return;
    consumedPage.current = search.data;
    setScan((current) => advanceChatHistoryScan(current, search.data!));
  }, [search.data, search.isPending, paused, scan.done]);
  const matches = mergeChatHistoryMatches(
    [...previous, ...scan.matches],
    search.data?.matches ?? [],
  );
  return (
    <section className="space-y-2 border-t border-border py-3">
      <h3 className="text-sm font-medium">{computer.label}</h3>
      {search.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Searching chats...
        </p>
      )}
      {search.error && (
        <p role="alert" className="text-sm text-destructive">
          {computer.label} could not be searched. It may be disconnected or need an update.
        </p>
      )}
      {(search.error ||
        search.data?.coverage.some((coverage) => coverage.status === "unavailable")) && (
        <Button
          variant="outline"
          onClick={() => {
            setScan((current) => ({
              ...current,
              done: false,
              seenCursors: current.seenCursors.filter(
                (cursor) => cursor !== (current.codexCursor ?? ""),
              ),
            }));
            search.refresh();
          }}
        >
          Retry this computer
        </Button>
      )}
      {search.data?.coverage.map((coverage) => (
        <p key={coverage.source} className="text-xs text-muted-foreground">
          {coverage.source === "t3" ? "T3" : "Codex app"}: {coverage.status}. {coverage.detail}
        </p>
      ))}
      {scan.readGaps && (
        <p className="text-xs text-muted-foreground">
          An earlier page had missing or unreadable message history. Coverage remains incomplete.
        </p>
      )}
      {!search.isPending && (scan.done || paused) && search.data && matches.length === 0 && (
        <p className="text-sm text-muted-foreground">No matches in the searched chats.</p>
      )}
      {!scan.done && !search.error && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {paused
              ? "Search stopped. Results show chats checked so far."
              : `Searching older Codex chats. ${scan.pages} pages checked.`}
          </p>
          <Button variant="outline" onClick={() => setPaused(!paused)}>
            {paused ? "Continue searching" : "Stop searching"}
          </Button>
          {search.isPending && !paused && (
            <p className="text-xs text-muted-foreground">Stops after the current page.</p>
          )}
        </div>
      )}
      {matches.map((match) => (
        <button
          type="button"
          key={`${match.source}:${match.threadId}`}
          onClick={() => onOpen(match, computer)}
          className="block w-full rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="block text-sm font-medium">{match.title}</span>
          <span className="block text-xs text-muted-foreground">
            {computer.label} · {match.source === "t3" ? "T3" : "Codex app"} ·{" "}
            {new Date(match.updatedAt).toLocaleDateString()}
            {match.archived ? " · Archived" : ""} · Read-only
          </span>
          <span className="block break-words text-sm text-muted-foreground">{match.snippet}</span>
        </button>
      ))}
      {search.data?.nextT3Offset != null && (
        <Button
          variant="outline"
          disabled={search.isPending || (!scan.done && !paused)}
          onClick={() => {
            setPrevious(matches);
            setT3Offset(search.data!.nextT3Offset!);
          }}
        >
          Show more T3 matches
        </Button>
      )}
    </section>
  );
}

function ChatReader({
  selected,
  onBack,
}: {
  selected: { match: ChatHistoryMatch; computer: Computer };
  onBack: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const read = useEnvironmentQuery(
    orchestrationEnvironment.chatHistoryRead({
      environmentId: selected.computer.environmentId,
      input: { source: selected.match.source, threadId: selected.match.threadId, offset },
    }),
  );
  return (
    <div className="space-y-3">
      <Button variant="outline" onClick={onBack}>
        Back to results
      </Button>
      <h3 className="break-words font-medium">{read.data?.title ?? selected.match.title}</h3>
      <p className="text-xs text-muted-foreground">
        {selected.computer.label} · Read-only. Opening this view does not resume or change the chat.
      </p>
      {read.isPending && <p role="status">Opening chat...</p>}
      {read.error && (
        <p role="alert">This chat could not be opened. The computer may be disconnected.</p>
      )}
      {read.error && (
        <Button variant="outline" onClick={read.refresh}>
          Retry opening chat
        </Button>
      )}
      <p className="text-sm text-muted-foreground">Matched text: {selected.match.snippet}</p>
      {read.data?.truncated && (
        <p role="status" className="text-sm text-muted-foreground">
          Long messages on this page are shortened to 8,000 characters.
        </p>
      )}
      <div className="flex gap-2">
        {read.data?.nextOffset != null && (
          <Button
            variant="outline"
            disabled={read.isPending}
            onClick={() => setOffset(read.data!.nextOffset!)}
          >
            Older messages
          </Button>
        )}
        {offset > 0 && (
          <Button
            variant="outline"
            disabled={read.isPending}
            onClick={() => setOffset(Math.max(0, offset - CHAT_HISTORY_MESSAGE_PAGE_SIZE))}
          >
            Newer messages
          </Button>
        )}
      </div>
      {read.data?.messages.map((message) => (
        <article key={message.id} className="border-t border-border py-3">
          <p className="text-xs font-medium text-muted-foreground">
            {message.role === "user" ? "You" : "Assistant"}
            {message.createdAt ? ` · ${new Date(message.createdAt).toLocaleString()}` : ""}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
        </article>
      ))}
    </div>
  );
}

export function ChatHistorySearchDialog({ computers }: { computers: ReadonlyArray<Computer> }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const fromLink = () => {
      if (window.location.hash === "#search-chats") show();
    };
    window.addEventListener(CHAT_HISTORY_SEARCH_EVENT, show);
    window.addEventListener("hashchange", fromLink);
    fromLink();
    return () => {
      window.removeEventListener(CHAT_HISTORY_SEARCH_EVENT, show);
      window.removeEventListener("hashchange", fromLink);
    };
  }, []);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [computerId, setComputerId] = useState("");
  const [submitted, setSubmitted] = useState<{
    input: ChatHistorySearchInput;
    computerId: string;
    revision: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ match: ChatHistoryMatch; computer: Computer } | null>(
    null,
  );
  return (
    <>
      <Button variant="ghost" className="w-full justify-start" onClick={() => setOpen(true)}>
        Search all chats
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="flex max-h-[90dvh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Search chats</DialogTitle>
            <DialogDescription>
              Find T3 and Codex app chats across your computers, including archives.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-4 pb-4">
            {selected && (
              <ChatReader
                key={`${selected.computer.environmentId}:${selected.match.source}:${selected.match.threadId}`}
                selected={selected}
                onBack={() => setSelected(null)}
              />
            )}
            <div hidden={selected !== null} className="space-y-4">
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    const input = chatHistoryDateInput(query, from, through);
                    setSubmitted({ input, computerId, revision: (submitted?.revision ?? 0) + 1 });
                    setError("");
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Check the dates.");
                  }
                }}
              >
                <label className="block text-sm">
                  Chat name or message text
                  <input
                    autoFocus
                    maxLength={200}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="mt-1 block w-full rounded-md border border-input bg-background p-2"
                  />
                </label>
                <label className="block text-sm">
                  Computer
                  <select
                    value={computerId}
                    onChange={(event) => setComputerId(event.target.value)}
                    className="ml-2 rounded-md border border-input bg-background p-2"
                  >
                    <option value="">All computers</option>
                    {computers.map((computer) => (
                      <option key={computer.environmentId} value={computer.environmentId}>
                        {computer.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-3">
                  <label className="text-sm">
                    From
                    <input
                      type="date"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                      className="ml-2 rounded-md border border-input bg-background p-2"
                    />
                  </label>
                  <label className="text-sm">
                    Through
                    <input
                      type="date"
                      value={through}
                      onChange={(event) => setThrough(event.target.value)}
                      className="ml-2 rounded-md border border-input bg-background p-2"
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Dates use this device's calendar. Text searches messages sent during the date
                  range, or chat names updated during it.
                </p>
                <Button type="submit">Search chats</Button>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </form>
              {computers.length === 0 && (
                <p>No computers are connected. Add a computer to search its chats.</p>
              )}
              {submitted &&
                computers
                  .filter(
                    (computer) =>
                      !submitted.computerId || submitted.computerId === computer.environmentId,
                  )
                  .map((computer) => (
                    <ComputerResults
                      key={`${submitted.revision}:${computer.environmentId}`}
                      computer={computer}
                      input={submitted.input}
                      onOpen={(match, computer) => setSelected({ match, computer })}
                    />
                  ))}
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
