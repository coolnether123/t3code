import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { serializeTaskTranscripts } from "./chatTranscript";
it("keeps transcript titles and identifiers in the selected order", () => {
  expect(
    serializeTaskTranscripts([
      { title: "First", threadId: ThreadId.make("one"), items: [] },
      { title: "Second", threadId: ThreadId.make("two"), items: [] },
    ]),
  ).toBe("Title: First\nThread: one\n\n---\n\nTitle: Second\nThread: two");
});
