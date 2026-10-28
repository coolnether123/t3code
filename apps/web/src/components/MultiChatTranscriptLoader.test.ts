import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { copyThreadTranscripts } from "./MultiChatTranscriptLoader";
const refs = ["first", "second"].map((id) =>
  scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(id)),
);
const transcript = (title: string) => ({ title, threadId: ThreadId.make(title), items: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("full transcript copy", () => {
  it("loads full transcripts in parallel but writes once in selection order", async () => {
    const second = deferred<ReturnType<typeof transcript>>();
    const first = deferred<ReturnType<typeof transcript>>();
    const write = vi.fn(async (_text: string) => true);
    const copying = copyThreadTranscripts(
      refs,
      (ref) => (ref.threadId === "first" ? first.promise : second.promise),
      write,
    );
    second.resolve(transcript("Second"));
    expect(write).not.toHaveBeenCalled();
    first.resolve(transcript("First"));
    expect(await copying).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const text = write.mock.calls[0]?.[0] ?? "";
    expect(text.indexOf("Title: First")).toBeLessThan(text.indexOf("Title: Second"));
  });
  it("does not write a partial batch when a chat cannot load", async () => {
    const write = vi.fn(async (_text: string) => true);
    await expect(
      copyThreadTranscripts(
        refs,
        async (ref) => {
          if (ref.threadId === "second") throw Error("offline");
          return transcript("First");
        },
        write,
      ),
    ).rejects.toThrow("offline");
    expect(write).not.toHaveBeenCalled();
  });
  it("propagates clipboard failure so selection is retained", async () => {
    await expect(
      copyThreadTranscripts(
        refs,
        async () => transcript("Saved"),
        async () => {
          throw Error("clipboard denied");
        },
      ),
    ).rejects.toThrow("clipboard denied");
  });
  it("does not copy an obsolete request", async () => {
    const write = vi.fn(async (_text: string) => true);
    expect(
      await copyThreadTranscripts(
        refs,
        async () => transcript("Saved"),
        write,
        () => false,
      ),
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("does not write an empty selection", async () => {
    const write = vi.fn(async (_text: string) => true);
    expect(await copyThreadTranscripts([], async () => transcript("Saved"), write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
