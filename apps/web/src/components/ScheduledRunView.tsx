import type { CodexDesktopMessage, CodexDesktopThreadHistoryResponse } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { scheduledApi } from "../scheduledApi";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";

function Message({ message }: { message: CodexDesktopMessage }) {
  return (
    <article className="border-b border-border/50 py-4" data-message-role={message.role}>
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {message.role === "tool"
          ? (message.tool?.name ?? "Tool")
          : message.role === "user"
            ? "You"
            : "Codex"}
      </div>
      {message.role === "tool" || message.role === "user" ? (
        <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
      ) : (
        <ChatMarkdown cwd={undefined} text={message.text} className="text-sm" />
      )}
    </article>
  );
}

export function ScheduledRunView({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const [history, setHistory] = useState<CodexDesktopThreadHistoryResponse | null>(null);
  const [messages, setMessages] = useState<readonly CodexDesktopMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void scheduledApi
      .getRun(runId)
      .then((page) => {
        if (!active) return;
        setHistory(page);
        setMessages(page.messages);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch(() => {
        if (active)
          setError("Could not open this run. It may have been removed from the Codex host.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [runId]);

  const loadOlder = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await scheduledApi.getRun(runId, cursor);
      setMessages((previous) => [...page.messages, ...previous]);
      setCursor(page.nextCursor);
      setError(null);
    } catch {
      setError("Could not load older messages.");
    } finally {
      setLoading(false);
    }
  };

  const title =
    history?.thread.title
      ?.split(/\r?\n/, 1)[0]
      ?.replace(/^Automation:\s*/i, "")
      .trim() || "Scheduled run";
  return (
    <SidebarInset className="min-h-0">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4 md:pl-14">
          <Button
            aria-label="Back to chats"
            variant="ghost"
            size="icon"
            onClick={() => void navigate({ to: "/" })}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          <span className="text-xs text-muted-foreground">Read-only</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
          <div className="mx-auto max-w-3xl">
            <p className="border-b border-border py-4 text-xs text-muted-foreground">
              This Codex desktop run is read-only. Continuing a specific automation run in a T3 chat
              is not available yet.
            </p>
            {cursor ? (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void loadOlder()}
                className="my-4"
              >
                Older messages
              </Button>
            ) : null}
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {loading ? <p className="py-4 text-sm text-muted-foreground">Loading…</p> : null}
            {error ? (
              <p role="alert" className="py-4 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {!loading && !error && history && messages.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No messages in this run.</p>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
