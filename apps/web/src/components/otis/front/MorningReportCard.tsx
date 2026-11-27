import type { OtisFront } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { FrontCard, type RunFrontAction } from "./FrontCard";
import { chicagoTime } from "./front.logic";

export function MorningReportCard({
  report,
  disabled,
  run,
  play,
  heard,
}: {
  report: OtisFront.MorningReport;
  disabled: boolean;
  run: RunFrontAction;
  play: () => Promise<void>;
  heard: () => Promise<void>;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  function act(action: () => Promise<void>) {
    setBusy(true);
    void action().finally(() => setBusy(false));
  }
  const summary = report.heardAt
    ? gt("{title} report · heard {time}", {
        title: report.title,
        time: chicagoTime.format(new Date(report.heardAt)),
      })
    : `${report.title} · ${report.windowLabel} · ${report.summary}`;
  const controls = !report.heardAt && (
    <>
      <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => act(play)}>
        {gt("Play")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() =>
          act(async () => {
            await heard();
            setOpen(false);
          })
        }
      >
        {gt("Heard")}
      </Button>
    </>
  );
  const body = (
    <div className="space-y-3 p-3">
      {report.sections.map((section) =>
        section.items.length === 0 && !section.empty ? null : (
          <section key={section.id} className="space-y-1.5">
            <h3 className="text-2xs font-medium text-muted-foreground uppercase">
              {section.title}
            </h3>
            {section.items.length ? (
              section.items.map((card) => (
                <FrontCard key={card.id} card={card} run={run} disabled={disabled} />
              ))
            ) : (
              <p className="text-xs text-muted-foreground">{section.empty}</p>
            )}
          </section>
        ),
      )}
    </div>
  );
  return (
    <div className="shrink-0 border-b border-border bg-card">
      <div className="hidden @min-[1024px]:block">
        <div className="flex min-h-9 items-center gap-1 px-3 text-xs">
          <span className="min-w-0 flex-1 truncate">{summary}</span>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? gt("Close") : gt("Open")}
          </Button>
          {controls}
        </div>
        {open && <div className="max-h-[35dvh] overflow-y-auto">{body}</div>}
      </div>
      <div className="@min-[1024px]:hidden">
        <Sheet>
          <SheetTrigger
            render={
              <button type="button" className="min-h-11 w-full truncate px-3 text-left text-xs" />
            }
          >
            {report.heardAt ? summary : `${report.title} · ${report.summary}`}
          </SheetTrigger>
          <SheetContent side="bottom">
            <div className="px-4 pt-4">
              <SheetTitle>{report.title}</SheetTitle>
            </div>
            <div className="px-3">{controls}</div>
            <div className="min-h-0 overflow-y-auto">{body}</div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
