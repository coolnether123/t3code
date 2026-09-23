import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaEnvironment } from "@t3tools/shared/usageQuota";

import {
  decodePublicResetHistory,
  publicResetCostEstimates,
  publicResetIntervals,
  watchPublicResetHistory,
} from "./publicResetHistory.ts";

const now = Date.parse("2026-09-13T22:00:00Z");
const regular = (id: string, announcedAt: string) => ({
  id,
  reset_type: "regular",
  announced_at: announcedAt,
  text: `Reset ${id}`,
  source: {
    type: "x_post",
    author: "thsottiaux",
    url: `https://x.com/thsottiaux/status/${id}`,
  },
});
const fixture = () => ({
  data: [
    regular("2098685367058612394", "2026-09-12T08:09:17Z"),
    {
      id: "2095651088502591861",
      reset_type: "banked",
      announced_at: "2026-09-03T23:12:30Z",
      text: "A banked reset is available.",
      source: {
        type: "x_post",
        author: "thsottiaux",
        url: "https://x.com/thsottiaux/status/2095651088502591861",
      },
    },
    regular("2094251180121854309", "2026-08-31T02:29:25Z"),
  ],
  pagination: { has_more: false, next_cursor: null },
  meta: { api_version: "v1", generated_at: "2026-09-13T21:59:00Z" },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Codex Resets history", () => {
  it("decodes documented announcements and excludes banked grants from boundaries", () => {
    const decoded = decodePublicResetHistory(fixture(), now)!;
    expect(decoded.map((item) => item.id)).toEqual([
      "2094251180121854309",
      "2095651088502591861",
      "2098685367058612394",
    ]);
    expect(publicResetIntervals(decoded)).toEqual([
      {
        id: "codex-resets:2094251180121854309",
        sinceTime: "2026-08-31T02:29:25Z",
        untilTime: "2026-09-12T08:09:17Z",
      },
    ]);
  });

  it("rejects malformed, future-dated, or untrusted records", () => {
    for (const document of [
      null,
      { ...fixture(), meta: { api_version: "v2", generated_at: "2026-09-13T21:59:00Z" } },
      { ...fixture(), data: [{ ...regular("1", "2026-09-14T22:00:00Z") }] },
      {
        ...fixture(),
        data: [
          {
            ...regular("1", "2026-09-01T00:00:00Z"),
            source: {
              type: "x_post",
              author: "someone",
              url: "https://x.com.evil.test/thsottiaux/status/1",
            },
          },
        ],
      },
    ]) {
      expect(decodePublicResetHistory(document, now)).toBeNull();
    }
  });

  it("aggregates model cost once per physical Codex source", () => {
    const announcements = decodePublicResetHistory(fixture(), now)!;
    const fingerprint = {
      hostId: "desktop",
      provider: "codex" as const,
      resolvedHomePath: "/codex",
      volumeId: "disk",
    };
    const environment = {
      environmentId: "desktop",
      label: "Desktop",
      isPending: false,
      error: null,
      summary: {
        sources: [{ fingerprint, status: "ok" as const }],
        quotaCosts: [
          {
            intervalId: "codex-resets:2094251180121854309",
            fingerprint,
            costUsd: 12.5,
            records: 4,
            unpricedRecords: 0,
            complete: true,
            models: [
              {
                model: "gpt-5.6-sol",
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 50,
                  cacheCreationTokens: 25,
                  outputTokens: 20,
                  reasoningTokens: 10,
                },
                costUsd: 12.5,
                records: 4,
                unpricedRecords: 0,
              },
            ],
          },
        ],
      },
    } as unknown as QuotaEnvironment;
    const row = publicResetCostEstimates(announcements, [environment, environment])[0]!;
    expect(row.costUsd).toBe(12.5);
    expect(row.records).toBe(4);
    expect(row.models[0]?.model).toBe("gpt-5.6-sol");
  });

  it("withholds partial, unpriced, and empty history instead of calling it zero", () => {
    const announcements = decodePublicResetHistory(fixture(), now)!;
    expect(publicResetCostEstimates(announcements, [])[0]?.costUsd).toBeNull();
    expect(publicResetCostEstimates(announcements, [])[0]?.reason).toContain("No computers");

    const fingerprint = {
      hostId: "desktop",
      provider: "codex" as const,
      resolvedHomePath: "/codex",
      volumeId: "disk",
    };
    const environment = (status: "ok" | "partial", complete: boolean, unpricedRecords: number) =>
      ({
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: {
          sources: [{ fingerprint, status }],
          quotaCosts: [
            {
              intervalId: "codex-resets:2094251180121854309",
              fingerprint,
              costUsd: 4,
              records: 2,
              unpricedRecords,
              complete,
              models: [],
            },
          ],
        },
      }) as unknown as QuotaEnvironment;

    const partial = publicResetCostEstimates(announcements, [environment("partial", false, 0)])[0]!;
    expect(partial.costUsd).toBeNull();
    expect(partial.reason).toContain("incomplete");

    const unpriced = publicResetCostEstimates(announcements, [environment("ok", true, 1)])[0]!;
    expect(unpriced.costUsd).toBeNull();
    expect(unpriced.reason).toContain("no model price");
  });

  it("reads the public endpoint without credentials and joins pending refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const response = Promise.withResolvers<Response>();
    const request = vi
      .fn()
      .mockImplementation((_input: RequestInfo | URL, _init?: RequestInit) => response.promise);
    vi.stubGlobal("fetch", request);
    const receive = vi.fn();
    const watcher = watchPublicResetHistory(receive);
    await vi.advanceTimersByTimeAsync(0);
    const first = watcher.refresh();
    expect(watcher.refresh()).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    response.resolve(new Response(JSON.stringify(fixture())));
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(String(request.mock.calls[0]![0])).toBe(
      "https://codex-resets.com/api/v1/resets?limit=100&order=desc",
    );
    expect(request.mock.calls[0]![1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
      headers: { accept: "application/json" },
    });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready", announcements: expect.any(Array) }),
    );
    watcher.stop();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
