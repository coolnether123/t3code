import { useGT } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { createBrowserAudio, requestSpeech } from "../../voice/browserSpeech";
import { useEffect, useRef, useState } from "react";
import { MicIcon, SquareIcon } from "lucide-react";
import { createDeviceSpeech } from "../../voice/deviceSpeech";

export function OtisDictation({
  environmentId,
  disabled = false,
  onText,
  onActiveChange,
}: {
  environmentId: EnvironmentId;
  disabled?: boolean;
  onText: (text: string) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const gt = useGT();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const audio = useRef<ReturnType<typeof createBrowserAudio> | null>(null);
  const [error, setError] = useState<string>();
  const speech = useRef<ReturnType<typeof createDeviceSpeech> | null>(null);
  const preparing = useRef(false);
  const abort = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Stop the recording and request when the dictation control unmounts.
  useEffect(
    () => () => {
      const controller = abort.current;
      abort.current = null;
      controller?.abort();
      audio.current?.close();
      onActiveChange(false);
    },
    [onActiveChange],
  );
  return (
    <>
      <button
        type="button"
        disabled={disabled || transcribing}
        aria-label={recording ? gt("Finish dictation") : gt("Dictate message")}
        onClick={async () => {
          if (recording) {
            if (preparing.current) {
              const controller = abort.current;
              abort.current = null;
              controller?.abort();
              audio.current?.close();
              onActiveChange(false);
              setRecording(false);
              return;
            }
            speech.current?.finish();
            audio.current?.finish();
            return;
          }
          const controller = new AbortController();
          abort.current = controller;
          preparing.current = false;
          const device = createDeviceSpeech();
          speech.current = device;
          setError(undefined);
          setRecording(true);
          onActiveChange(true);
          let lease: string | undefined;
          let microphone: ReturnType<typeof createBrowserAudio> | undefined;
          const capture = async () => {
            let text = await device.capture(controller.signal);
            if (controller.signal.aborted) return;
            if (text === null) {
              microphone = createBrowserAudio();
              audio.current = microphone;
              microphone.unlock();
              preparing.current = true;
              await microphone.prepare(controller.signal, "pc");
              preparing.current = false;
              if (controller.signal.aborted) return;
              const recording = await microphone.capture(controller.signal);
              microphone.close();
              if (!recording.audio) return;
              setTranscribing(true);
              const acquired = await requestSpeech(
                environmentId,
                { action: "acquire" },
                controller.signal,
              );
              lease = acquired.sessionId;
              if (!lease) throw new Error(gt("Dictation is unavailable. Try again."));
              const result = await requestSpeech(
                environmentId,
                { action: "transcribe", sessionId: lease, ...recording },
                controller.signal,
              );
              text = result.text ?? "";
            }
            if (!controller.signal.aborted && text.trim()) onText(text.trim());
          };
          await capture()
            .catch((error: unknown) => {
              if (!controller.signal.aborted)
                setError(error instanceof Error ? error.message : gt("Dictation failed."));
            })
            .finally(async () => {
              microphone?.close();
              if (audio.current === microphone) audio.current = null;
              if (lease)
                await requestSpeech(
                  environmentId,
                  { action: "release", sessionId: lease },
                  AbortSignal.timeout(30000),
                ).catch(() => {});
              if (abort.current === controller) {
                preparing.current = false;
                onActiveChange(false);
                if (!controller.signal.aborted) {
                  setRecording(false);
                  setTranscribing(false);
                }
              }
            });
        }}
      >
        {recording ? <SquareIcon /> : <MicIcon />}
      </button>
      {error ? (
        <span
          role="alert"
          className="absolute inset-x-4 bottom-full mb-2 rounded-xl bg-otis-bubble p-3 text-sm"
        >
          {error}
        </span>
      ) : null}
    </>
  );
}
