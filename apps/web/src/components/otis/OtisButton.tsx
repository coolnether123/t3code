import { OtisRing } from "./OtisRing";
import { useEffect, useRef, useState } from "react";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { requestSpeech } from "../../voice/browserSpeech";
import "./otis.css";

export function OtisButton({
  environmentId,
  onOpen,
}: {
  environmentId: EnvironmentId | null;
  onOpen: (thread: ScopedThreadRef) => unknown;
}) {
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        className="flex w-full items-center gap-3 rounded-2xl bg-otis-chrome px-4 py-3 text-left font-sans font-semibold text-otis-text disabled:opacity-50"
        disabled={busy || !environmentId}
        onClick={async () => {
          if (!environmentId || busy) return;
          const controller = new AbortController();
          abort.current = controller;
          setBusy(true);
          setError(undefined);
          try {
            const result = await requestSpeech(
              environmentId,
              { action: "otis.open", callId: "otis" },
              controller.signal,
            );
            if (controller.signal.aborted) return;
            if (!result.threadId) throw new Error("Otis chat could not be opened.");
            await onOpen(scopeThreadRef(environmentId, ThreadId.make(result.threadId)));
          } catch (error) {
            if (!controller.signal.aborted)
              setError(error instanceof Error ? error.message : "Otis is unavailable.");
          } finally {
            if (!controller.signal.aborted) setBusy(false);
          }
        }}
      >
        <OtisRing small />
        {busy ? "Opening Otis..." : "Otis"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
