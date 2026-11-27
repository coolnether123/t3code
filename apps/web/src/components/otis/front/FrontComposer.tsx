import type { EnvironmentId, OtisFront } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState, type FormEvent } from "react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { OtisDictation } from "../OtisDictation";
import { CallBar, type FrontCall } from "./CallBar";

export function FrontComposer({
  environmentId,
  state,
  voice,
  disabled,
  stopping,
  pending,
  onSend,
  onStop,
}: {
  environmentId: EnvironmentId;
  state: OtisFront.FrontState | null;
  voice: FrontCall;
  disabled: boolean;
  stopping: boolean;
  pending: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (disabled || pending) return;
    if (stopping) onStop();
    else if (draft.trim()) {
      onSend(draft.trim());
      setDraft("");
    }
  }
  return (
    <footer className="pb-safe shrink-0 border-t border-border">
      {voice.state !== "idle" && <CallBar voice={voice} />}
      <form className="mx-auto max-w-[760px] px-3 py-2" onSubmit={submit}>
        <div className="relative flex items-end gap-1">
          <Textarea
            aria-label={gt("Message Otis")}
            placeholder={gt("Message Otis")}
            rows={1}
            className="max-h-[8rem] min-h-0 grow [field-sizing:content] resize-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing ||
                window.matchMedia("(pointer: coarse)").matches ||
                stopping
              )
                return;
              submit(event);
            }}
          />
          <OtisDictation
            environmentId={environmentId}
            disabled={disabled || voice.state !== "idle"}
            onText={(text) => setDraft((value) => (value ? `${value} ${text}` : text))}
          />
          <Button
            variant="outline"
            size="sm"
            type="submit"
            disabled={disabled || pending || (!stopping && !draft.trim())}
          >
            {stopping ? gt("Stop") : gt("Send")}
          </Button>
        </div>
        {state && (
          <p className="mt-1 text-xs text-muted-foreground">
            {gt("Talker {talker} ({effort}). Big jobs go to Otis #1 ({model}, {modelEffort}).", {
              talker: state.talker.model,
              effort: state.talker.effort,
              model: state.otis1.model,
              modelEffort: state.otis1.effort ?? gt("effort not reported"),
            })}
          </p>
        )}
      </form>
    </footer>
  );
}
