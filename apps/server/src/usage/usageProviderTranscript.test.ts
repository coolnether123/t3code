// @effect-diagnostics nodeBuiltinImport:off - Exercises the Promise-based transcript reader with disposable native files.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vite-plus/test";
import { piUsageFormat } from "@t3tools/provider-pi/server/usage";
import { readTranscriptRecords as readProviderTranscriptRecords } from "./usageProviderTranscriptReader.ts";

it("feeds metadata and usage to the provider-owned parser", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usage-provider-fixture-"));
  try {
    const file = path.join(directory, "pi.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "session", id: "synthetic-session" }),
        JSON.stringify({
          type: "usage",
          id: "synthetic-response",
          timestamp: "2026-10-19T06:00:00Z",
          provider: "openai",
          model: "synthetic-model",
          usage: { input: 10, output: 5, cacheRead: 3 },
        }),
      ].join("\n"),
    );
    const parsed = await readProviderTranscriptRecords(file, piUsageFormat);
    const records = parsed === null ? null : [...parsed.records, ...parsed.tailRecords];
    expect(records).toHaveLength(1);
    expect(records?.[0]).toMatchObject({
      provider: "pi",
      sessionId: "synthetic-session",
      totals: { uncachedInputTokens: 10, outputTokens: 5, cachedInputTokens: 3 },
    });
    expect(
      await readProviderTranscriptRecords(path.join(directory, "missing.jsonl"), piUsageFormat),
    ).toBeNull();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
