import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { assembleMultiChatTranscript } from "./MultiChatTranscriptLoader";

describe("assembleMultiChatTranscript", () => {
  it("uses selected-thread order even when transcripts finish in another order", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const firstRef = scopeThreadRef(environmentId, ThreadId.make("thread-first"));
    const secondRef = scopeThreadRef(environmentId, ThreadId.make("thread-second"));
    const result = assembleMultiChatTranscript(
      { id: 1, threadRefs: [firstRef, secondRef] },
      new Map([
        [scopedThreadKey(secondRef), transcript("Second")],
        [scopedThreadKey(firstRef), transcript("First")],
      ]),
      scopedThreadKey,
    );

    const copiedText = result ?? "";
    expect(copiedText.indexOf("Title: First")).toBeLessThan(copiedText.indexOf("Title: Second"));
  });

  it("does not assemble a partial selection", () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-local"),
      ThreadId.make("thread-first"),
    );

    expect(
      assembleMultiChatTranscript({ id: 2, threadRefs: [threadRef] }, new Map(), scopedThreadKey),
    ).toBeNull();
  });
});

function transcript(title: string) {
  return { title, threadId: title, messages: [], activities: [] };
}
