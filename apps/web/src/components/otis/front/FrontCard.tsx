import type { OtisFront } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { createContext, useContext, useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { frontLink } from "./front.logic";

export type RunFrontAction = (action: OtisFront.Action, input?: string) => Promise<void>;
export const FrontTaskDashboard = createContext<string | undefined>(undefined);

export function FrontActions({
  actions,
  run,
  disabled,
}: {
  actions: readonly OtisFront.Action[];
  run: RunFrontAction;
  disabled: boolean;
}) {
  const gt = useGT();
  const [selected, select] = useState<OtisFront.Action | null>(null);
  const [confirmed, confirm] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  function submit(action: OtisFront.Action, answer?: string) {
    setBusy(true);
    void run(action, answer)
      .then(
        () => select(null),
        () => undefined,
      )
      .finally(() => setBusy(false));
  }
  const confirming = selected !== null && selected.confirm !== null && !confirmed;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {actions.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => {
              setInput("");
              confirm(false);
              if (action.confirm !== null || action.input !== null) select(action);
              else submit(action);
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {selected && (
        <AlertDialog
          open={confirming}
          onOpenChange={(open) => {
            if (!open) select(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{selected.label}</AlertDialogTitle>
              <AlertDialogDescription>{selected.confirm}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                {gt("Cancel")}
              </AlertDialogClose>
              <Button
                disabled={disabled || busy}
                onClick={() => {
                  if (selected.input === null) submit(selected);
                  else confirm(true);
                }}
              >
                {selected.label}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {selected?.input != null && !confirming && (
        <form
          className="flex basis-full items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (input.trim()) submit(selected, input.trim());
          }}
        >
          <Input
            aria-label={selected.input}
            placeholder={selected.input}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={disabled || busy || !input.trim()}>
            {gt("Send")}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => select(null)}>
            {gt("Cancel")}
          </Button>
        </form>
      )}
    </>
  );
}

const tone = {
  neutral: "text-muted-foreground",
  good: "text-foreground",
  warn: "text-warning-foreground",
  bad: "text-destructive",
};

function CardLine({ line }: { line: OtisFront.CardLine }) {
  const link = frontLink(line.href, useContext(FrontTaskDashboard));
  const className = "underline underline-offset-2";
  const content =
    link?.kind === "node" ? (
      <Link to="/otis/node/$nodeId" params={{ nodeId: link.id }} className={className}>
        {line.text}
      </Link>
    ) : link?.kind === "external" ? (
      <a href={link.href} target="_blank" rel="noreferrer" className={className}>
        {line.text}
      </a>
    ) : (
      line.text
    );
  return (
    <li className="wrap-anywhere">
      {line.label && <span className="mr-1 text-muted-foreground">{line.label}</span>}
      {content}
    </li>
  );
}

export function FrontCard({
  card,
  run,
  disabled,
}: {
  card: OtisFront.Card;
  run: RunFrontAction;
  disabled: boolean;
}) {
  return (
    <section
      data-front-card={card.id}
      className="min-w-0 rounded-md border border-border px-2.5 py-2 text-xs"
    >
      <header className="flex flex-wrap justify-between gap-x-2 text-sm">
        <h3 className="font-semibold">{card.title}</h3>
        {card.status && <span className={tone[card.status.tone]}>{card.status.label}</span>}
      </header>
      <ul className="my-1 space-y-0.5">
        {card.lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Card lines are positional display text with no ID or interactive state.
          <CardLine key={index} line={line} />
        ))}
      </ul>
      {card.actions.length > 0 && (
        <FrontActions actions={card.actions} run={run} disabled={disabled} />
      )}
    </section>
  );
}
