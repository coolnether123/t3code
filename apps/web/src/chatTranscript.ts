import type { OrchestrationV2ThreadTranscript } from "@t3tools/contracts";
export type TaskTranscriptInput = Pick<
  OrchestrationV2ThreadTranscript,
  "title" | "threadId" | "items"
>;
export function serializeTaskTranscripts(transcripts: ReadonlyArray<TaskTranscriptInput>): string {
  return transcripts
    .map((t) =>
      [
        `Title: ${t.title}`,
        `Thread: ${t.threadId}`,
        ...t.items.map((item) => JSON.stringify(item)),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}
