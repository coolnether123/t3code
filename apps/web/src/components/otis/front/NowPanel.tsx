import type { OtisFront } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useState } from "react";
import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { FrontActions, type RunFrontAction } from "./FrontCard";

const storageKey = "otis.front.nowCollapsed";

function initialCollapsed() {
  try {
    return localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

function WaitingRow({
  item,
  run,
  disabled,
}: {
  item: OtisFront.WaitingItem;
  run: RunFrontAction;
  disabled: boolean;
}) {
  const since = useRelativeTimeState(item.since);
  return (
    <li className="flex min-h-11 flex-wrap items-center justify-between gap-x-2 py-1 @min-[1024px]:min-h-8">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full bg-warning-foreground" />
          <Tooltip>
            <TooltipTrigger render={<span className="truncate" />}>{item.title}</TooltipTrigger>
            <TooltipPopup>{item.title}</TooltipPopup>
          </Tooltip>
        </div>
        <p className="pl-3.5 text-xs text-muted-foreground">
          {item.lane}
          {since.status === "relative" && ` · ${since.label}`}
        </p>
      </div>
      {item.actions.length > 0 && (
        <FrontActions actions={item.actions} run={run} disabled={disabled} />
      )}
    </li>
  );
}

function WorkingRow({ item }: { item: OtisFront.WorkingItem }) {
  const gt = useGT();
  const age = useRelativeTimeState(item.startedAt);
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/otis/node/$nodeId"
              params={{ nodeId: item.nodeId }}
              className="flex min-h-11 items-center justify-between gap-2 @min-[1024px]:min-h-8"
            />
          }
        >
          <span className="truncate">{item.title}</span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
            {item.model}
            {age.status === "relative" && ` · ${age.value}`}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {gt("{model}, {effort}", {
            model: item.model,
            effort: item.effort ?? gt("effort not reported"),
          })}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 py-1">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

export function NowPanel({
  state,
  unavailable,
  retry,
  run,
  disabled,
}: {
  state: OtisFront.FrontState | null;
  unavailable: boolean;
  retry: () => void;
  run: RunFrontAction;
  disabled: boolean;
}) {
  const gt = useGT();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  function toggle() {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(storageKey, String(!collapsed));
    } catch {}
  }
  if (unavailable)
    return (
      <div
        role="status"
        className="flex shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground"
      >
        <span>{gt("Can't reach Otis right now. Retrying.")}</span>
        <Button size="sm" variant="ghost" onClick={retry}>
          {gt("Retry now")}
        </Button>
      </div>
    );
  const waiting = state?.waiting.length ?? 0;
  const working = state?.working.length ?? 0;
  const strip = gt("{waiting} needs you · {working} running", { waiting, working });
  const labelClass = "mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase";
  function columns(inSheet: boolean) {
    return (
      <div
        className={
          inSheet
            ? "space-y-4 overflow-y-auto p-4"
            : "grid min-h-0 divide-y divide-border @min-[1024px]:grid-cols-2 @min-[1024px]:divide-x @min-[1024px]:divide-y-0"
        }
      >
        <section className="min-h-0 min-w-0 overflow-y-auto px-3 py-2">
          {inSheet ? (
            <h3 className={labelClass}>{gt("Waiting on you")}</h3>
          ) : (
            <button type="button" className={labelClass} onClick={toggle}>
              {gt("Waiting on you")} {state && `(${waiting})`}
            </button>
          )}
          {!state ? (
            <LoadingRows />
          ) : waiting === 0 ? (
            <p className="text-xs text-muted-foreground">{gt("Nothing needs you.")}</p>
          ) : (
            <ul>
              {state.waiting.map((item) => (
                <WaitingRow key={item.id} item={item} run={run} disabled={disabled} />
              ))}
            </ul>
          )}
        </section>
        <section className="min-h-0 min-w-0 overflow-y-auto px-3 py-2">
          {inSheet ? (
            <h3 className={labelClass}>{gt("Working now")}</h3>
          ) : (
            <button type="button" className={labelClass} onClick={toggle}>
              {gt("Working now")} {state && `(${working})`}
            </button>
          )}
          {!state ? (
            <LoadingRows />
          ) : working === 0 ? (
            <p className="text-xs text-muted-foreground">{gt("Nothing running.")}</p>
          ) : (
            <ul>
              {state.working.map((item) => (
                <WorkingRow key={item.nodeId} item={item} />
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }
  return (
    <div className="flex max-h-[40dvh] min-h-0 flex-col border-b border-border text-sm">
      <div className="hidden min-h-0 flex-col @lg:flex">
        {collapsed ? (
          <button
            type="button"
            className="min-h-8 px-3 text-left text-xs text-muted-foreground"
            onClick={toggle}
          >
            {strip}
          </button>
        ) : (
          columns(false)
        )}
      </div>
      <div className="@lg:hidden">
        <Sheet>
          <SheetTrigger
            render={
              <button
                type="button"
                className={`min-h-11 w-full px-3 text-left text-xs ${waiting ? "text-warning-foreground" : "text-muted-foreground"}`}
              />
            }
          >
            {state ? strip : gt("Now")}
          </SheetTrigger>
          <SheetContent side="bottom">
            <div className="px-4 pt-4">
              <SheetTitle>{gt("Now")}</SheetTitle>
            </div>
            {columns(true)}
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
