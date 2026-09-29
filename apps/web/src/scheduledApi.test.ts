import { describe, expect, it } from "vite-plus/test";

import { createScheduledApi } from "./scheduledApi";

const run = { id: "run-1", createdAt: "2026-09-28T12:00:00.000Z", preview: "Done", archived: true };

describe("scheduled run API", () => {
  it("uses the selected host base URL and encodes routine and page cursors", async () => {
    const urls: string[] = [];
    const api = createScheduledApi(
      async (url) => {
        urls.push(url);
        return { runs: [run], nextCursor: null };
      },
      (path, searchParams) => {
        const url = new URL(path, "https://millie.example");
        url.search = new URLSearchParams(searchParams).toString();
        return url.toString();
      },
    );
    const page = await api.listRuns("ITA AR & inbox", "25");
    expect(page.runs[0]?.archived).toBe(true);
    expect(urls).toEqual([
      "https://millie.example/api/codex/scheduled/runs?name=ITA+AR+%26+inbox&cursor=25",
    ]);
  });

  it("keeps transcript cursors in the query string", async () => {
    const urls: string[] = [];
    const api = createScheduledApi(
      async (url) => {
        urls.push(url);
        return {
          thread: {
            id: "run-1",
            title: null,
            updatedAt: run.createdAt,
            preview: null,
            cwd: null,
            status: "unknown",
          },
          messages: [],
          nextCursor: null,
        };
      },
      (path, searchParams) => {
        const url = new URL(path, "https://millie.example");
        url.search = new URLSearchParams(searchParams).toString();
        return url.toString();
      },
    );
    await api.getRun("run-1", "byte:123:4");
    expect(urls).toEqual([
      "https://millie.example/api/codex/scheduled/runs/run-1?beforeCursor=byte%3A123%3A4",
    ]);
  });

  it("does not accept a malformed run response", async () => {
    const api = createScheduledApi(
      async () => ({ runs: [{ ...run, archived: 1 }], nextCursor: null }),
      (path) => path,
    );
    await expect(api.listRuns("Inbox")).rejects.toThrow();
  });
});
