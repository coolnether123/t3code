import type { CodexScheduledRoutine, CodexScheduledRun } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, Clock3Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { scheduledApi } from "../../scheduledApi";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SidebarGroup, useSidebar } from "../ui/sidebar";

function RunHistory({ routine }: { routine: CodexScheduledRoutine }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [runs, setRuns] = useState<readonly CodexScheduledRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next?: string) => {
      setLoading(true);
      try {
        const page = await scheduledApi.listRuns(routine.name, next);
        setRuns((previous) => (next ? [...previous, ...page.runs] : page.runs));
        setCursor(page.nextCursor);
        setLoaded(true);
        setError(null);
      } catch {
        setError("Could not load run history.");
      } finally {
        setLoading(false);
      }
    },
    [routine.name],
  );

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{routine.name}</span>
        <span className="shrink-0 text-xs text-sidebar-muted-foreground">
          {formatRelativeTimeLabel(routine.latestRun.createdAt)}
        </span>
        <span
          className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground"
          aria-label={`${routine.runCount} runs`}
        >
          {routine.runCount}
        </span>
      </button>
      {open ? (
        <div className="ml-4 border-l border-sidebar-border pl-2">
          {loaded && runs.length === 0 ? (
            <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">No runs yet</p>
          ) : null}
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate({ to: "/scheduled/$runId", params: { runId: run.id } });
              }}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="shrink-0">{formatRelativeTimeLabel(run.createdAt)}</span>
              <span className="min-w-0 flex-1 truncate">{run.preview?.trim() || "Run"}</span>
              {run.archived ? <span className="shrink-0">Archived</span> : null}
            </button>
          ))}
          {error ? (
            <button
              type="button"
              onClick={() => void load()}
              className="px-2 py-1 text-xs text-destructive"
            >
              {error} Retry
            </button>
          ) : null}
          {cursor && !loading ? (
            <button
              type="button"
              onClick={() => void load(cursor)}
              className="px-2 py-1 text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
            >
              More runs
            </button>
          ) : null}
          {loading ? (
            <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">Loading…</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Native Codex automation runs have their own shelf, never a T3 chat projection. */
export function ScheduledSidebarSection() {
  const [open, setOpen] = useState(false);
  const [routines, setRoutines] = useState<readonly CodexScheduledRoutine[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async (next?: string) => {
    setLoading(true);
    try {
      const page = await scheduledApi.listRoutines(next);
      setRoutines((previous) => (next ? [...previous, ...page.routines] : page.routines));
      setCursor(page.nextCursor);
      setLoaded(true);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, load]);

  return (
    <SidebarGroup
      className="border-t border-sidebar-border px-[var(--sidebar-content-inset)] py-2"
      aria-label="Scheduled"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Clock3Icon className="size-4" />
        <span className="flex-1">Scheduled</span>
        {open ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronRightIcon className="size-3.5" />
        )}
      </button>
      {open ? (
        <div>
          {loaded && routines.length === 0 ? (
            <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
              No scheduled runs on this Codex host.
            </p>
          ) : null}
          {routines.map((routine) => (
            <RunHistory key={routine.name} routine={routine} />
          ))}
          {error ? (
            <button
              type="button"
              onClick={() => void load()}
              className="px-2 py-1 text-xs text-destructive"
            >
              Could not load scheduled runs. Retry
            </button>
          ) : null}
          {cursor && !loading ? (
            <button
              type="button"
              onClick={() => void load(cursor)}
              className="px-2 py-1 text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
            >
              More routines
            </button>
          ) : null}
          {loading ? (
            <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">Loading…</p>
          ) : null}
        </div>
      ) : null}
    </SidebarGroup>
  );
}
