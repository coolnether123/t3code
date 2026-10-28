import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRef } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serializeTaskTranscripts, type TaskTranscriptInput } from "../chatTranscript";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
import { useStableCallback } from "../hooks/useStableCallback";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { toastManager } from "./ui/toast";

export async function copyThreadTranscripts(
  threadRefs: ReadonlyArray<ScopedThreadRef>,
  load: (ref: ScopedThreadRef) => Promise<TaskTranscriptInput>,
  write: (text: string) => Promise<boolean>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (threadRefs.length === 0) return false;
  const transcripts = await Promise.all(threadRefs.map(load));
  return isCurrent() ? write(serializeTaskTranscripts(transcripts)) : false;
}

export function useMultiChatTranscriptCopy(
  onCopied?: (refs: ReadonlyArray<ScopedThreadRef>) => void,
) {
  const requestId = useRef(0);
  const copyTail = useRef(Promise.resolve(false));
  const load = useAtomCommand(orchestrationEnvironment.threadTranscript, { reportFailure: false });
  const startCopy = useStableCallback(async (threadRefs: ReadonlyArray<ScopedThreadRef>) => {
    const refs = [...threadRefs];
    const id = ++requestId.current;
    try {
      const copied = await copyThreadTranscripts(
        refs,
        async (ref) => {
          const result = await load({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId },
          });
          if (result._tag !== "Success") throw squashAtomCommandFailure(result);
          return result.value;
        },
        (text) => {
          const copying = copyTail.current
            .catch(() => false)
            .then(() =>
              requestId.current === id ? writeTextToClipboard(text, "chat transcripts") : false,
            );
          copyTail.current = copying;
          return copying;
        },
        () => requestId.current === id,
      );
      if (!copied || requestId.current !== id) return;
      onCopied?.(refs);
      toastManager.add({
        type: "success",
        title: refs.length === 1 ? "Chat copied" : "Chats copied",
      });
    } catch (error) {
      if (requestId.current !== id) return;
      toastManager.add({
        type: "error",
        title: "Could not copy chats",
        description: error instanceof Error ? error.message : "Could not load a selected chat.",
      });
    }
  });
  return { startCopy };
}
