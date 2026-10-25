import { describe, expect, it, vi } from "vite-plus/test";
import { lookupVoiceAgenda } from "./voiceLookups.ts";

describe("voice agenda reads", () => {
  it("uses only the local GET route and returns bounded task fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        tasks: [
          {
            id: "task",
            title: "Voice",
            status: "open",
            needsAgent: "Verify",
            history: ["private history"],
          },
        ],
        partial: false,
      }),
    );
    const result = await lookupVoiceAgenda(
      { tool: "agenda_lookup", query: "voice" },
      new AbortController().signal,
      fetcher,
    );
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:5197/api/v1/agenda/search?query=voice&limit=5",
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(result).toMatchObject({
      tasks: [{ title: "Voice", needsAgent: "Verify" }],
      partial: false,
    });
    expect(JSON.stringify(result)).not.toContain("private history");
  });
  it("reads an exact agenda ID without inventing a source chat or a write", async () => {
    const id = "agenda-task:3cb18c1dd2084f7798c1d2a9db8dc36a";
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ id, title: "Voice", status: "open" }),
    );
    await lookupVoiceAgenda(
      { tool: "agenda_lookup", query: id },
      new AbortController().signal,
      fetcher,
    );
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `http://127.0.0.1:5197/api/v1/agenda/tasks/${encodeURIComponent(id)}`,
    );
    expect(fetcher.mock.calls[0]![1]?.method).toBe("GET");
  });
  it("reports unknown coverage for denied reads and rejects malformed evidence", async () => {
    const signal = new AbortController().signal;
    expect(
      await lookupVoiceAgenda(
        { tool: "agenda_lookup", query: "voice" },
        signal,
        async () => new Response("Denied", { status: 403 }),
      ),
    ).toMatchObject({ error: expect.stringContaining("Coverage is unknown") });
    await expect(
      lookupVoiceAgenda({ tool: "agenda_lookup", query: "voice" }, signal, async () =>
        Response.json({ tasks: [{ title: "missing ID" }] }),
      ),
    ).rejects.toThrow();
  });
  it("does not follow a model-supplied URL or execute another tool", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const signal = new AbortController().signal;
    await lookupVoiceAgenda({ tool: "run_status" }, signal, fetcher);
    await lookupVoiceAgenda({ tool: "agenda_lookup", query: "bad\nquery" }, signal, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
