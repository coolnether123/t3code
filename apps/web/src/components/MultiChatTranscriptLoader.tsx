import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";

import { serializeTaskTranscripts, type TaskTranscriptInput } from "../chatTranscript";
import { useThread } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "./ui/toast";

export type MultiChatCopyRequest = {
  readonly id: number;
  readonly threadRefs: ReadonlyArray<ScopedThreadRef>;
};

export function useMultiChatTranscriptCopy(
  onCopied?: (threadRefs: ReadonlyArray<ScopedThreadRef>) => void,
) {
  const [request, setRequest] = useState<MultiChatCopyRequest | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const requestRef = useRef(request);
  const resultsRef = useRef(new Map<string, TaskTranscriptInput>());
  const requestIdRef = useRef(0);
  const copyTailRef = useRef<Promise<void> | null>(null);
  const onCopiedRef = useRef(onCopied);
  useEffect(() => {
    onCopiedRef.current = onCopied;
  }, [onCopied]);

  const copyToClipboard = useCallback((text: string, copyRequest: MultiChatCopyRequest) => {
    copyTailRef.current = (copyTailRef.current ?? Promise.resolve()).then(() => {
      if (copyRequest.id !== requestIdRef.current) return;
      return writeTextToClipboard(text, "selected chat transcripts").then(
        (didCopy) => {
          if (!didCopy || copyRequest.id !== requestIdRef.current) return;
          toastManager.add({
            type: "success",
            title: copyRequest.threadRefs.length === 1 ? "Chat copied" : "Chats copied",
            description: `${copyRequest.threadRefs.length} chat transcripts copied to the clipboard.`,
          });
          setIsCopied(true);
          onCopiedRef.current?.(copyRequest.threadRefs);
        },
        (error: Error) => {
          if (copyRequest.id !== requestIdRef.current) return;
          console.error(error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not copy chats",
              description: error.message,
            }),
          );
        },
      );
    });
  }, []);

  const startCopy = useCallback((threadRefs: ReadonlyArray<ScopedThreadRef>) => {
    if (threadRefs.length === 0) return;
    setIsCopied(false);
    const nextRequest = { id: ++requestIdRef.current, threadRefs: [...threadRefs] };
    resultsRef.current.clear();
    requestRef.current = nextRequest;
    setRequest(nextRequest);
  }, []);

  const onError = useCallback((requestId: number, message: string) => {
    if (requestRef.current?.id !== requestId) return;
    requestRef.current = null;
    resultsRef.current.clear();
    setRequest(null);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not copy chats",
        description: message,
      }),
    );
  }, []);

  const onLoaded = useCallback(
    (requestId: number, threadRef: ScopedThreadRef, transcript: TaskTranscriptInput) => {
      const activeRequest = requestRef.current;
      if (!activeRequest || activeRequest.id !== requestId) return;
      const results = resultsRef.current;
      results.set(scopedThreadKey(threadRef), transcript);
      if (results.size !== activeRequest.threadRefs.length) return;
      const combinedTranscript = assembleMultiChatTranscript(
        activeRequest,
        results,
        scopedThreadKey,
      );
      if (combinedTranscript === null) return;
      copyToClipboard(combinedTranscript, activeRequest);
      requestRef.current = null;
      results.clear();
      setRequest(null);
    },
    [copyToClipboard],
  );

  useEffect(() => {
    if (!isCopied) return;
    const timeout = setTimeout(() => setIsCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [isCopied]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  return { request, startCopy, onLoaded, onError, isCopied };
}

export function MultiChatTranscriptLoader(props: {
  readonly requestId: number;
  readonly threadRef: ScopedThreadRef;
  readonly onLoaded: (
    requestId: number,
    threadRef: ScopedThreadRef,
    transcript: TaskTranscriptInput,
  ) => void;
  readonly onError: (requestId: number, message: string) => void;
}) {
  const { requestId, threadRef, onLoaded, onError } = props;
  const thread = useThread(threadRef);
  const state = useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  const completed = useRef(false);
  const requestedCursor = useRef<string | null | undefined>(undefined);
  const loadingCursor = useRef<string | null>(null);

  useEffect(() => {
    if (completed.current) return;
    if (state.status === "deleted") {
      completed.current = true;
      onError(requestId, "A selected chat was deleted before it could be copied.");
      return;
    }
    const loadError = Option.getOrNull(state.error);
    if (loadError !== null) {
      completed.current = true;
      onError(requestId, loadError);
      return;
    }
    const canUseCachedHistory = state.status === "cached" && Option.isSome(state.data);
    if ((state.status !== "live" && !canUseCachedHistory) || thread === null) return;

    if (threadHasOlderTurns(state)) {
      const page = Option.getOrNull(state.page);
      if (page === null || page.loadingOlder) {
        if (page?.loadingOlder) loadingCursor.current = page.beforeCursor;
        return;
      }
      if (canUseCachedHistory) {
        completed.current = true;
        onError(requestId, `Reconnect to copy the full history for "${thread.title}".`);
        return;
      }
      if (page.beforeCursor === null) {
        completed.current = true;
        onError(requestId, `Could not load the full history for "${thread.title}".`);
        return;
      }
      if (requestedCursor.current === page.beforeCursor) {
        if (loadingCursor.current === page.beforeCursor) {
          completed.current = true;
          onError(requestId, `Could not load the full history for "${thread.title}".`);
        }
        return;
      }
      requestedCursor.current = page.beforeCursor;
      if (!requestOlderThreadTurns(threadRef.environmentId, threadRef.threadId)) {
        completed.current = true;
        onError(requestId, `Could not load the full history for "${thread.title}".`);
      }
      return;
    }

    completed.current = true;
    onLoaded(requestId, threadRef, {
      title: thread.title,
      threadId: thread.id,
      messages: thread.messages,
      activities: thread.activities,
    });
  }, [onError, onLoaded, requestId, state, thread, threadRef]);

  return null;
}

export function assembleMultiChatTranscript(
  request: MultiChatCopyRequest,
  transcripts: ReadonlyMap<string, TaskTranscriptInput>,
  keyForThread: (ref: ScopedThreadRef) => string,
): string | null {
  const orderedTranscripts = request.threadRefs.flatMap((ref) => {
    const transcript = transcripts.get(keyForThread(ref));
    return transcript ? [transcript] : [];
  });
  if (orderedTranscripts.length !== request.threadRefs.length) return null;
  return serializeTaskTranscripts(orderedTranscripts);
}
