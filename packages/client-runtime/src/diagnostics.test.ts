import { describe, expect, it } from "vite-plus/test";
import { normalizeDiagnosticDetail } from "./diagnostics.js";

describe("normalizeDiagnosticDetail", () => {
  it("extracts a useful message from serialized diagnostics and preserves the raw payload", () => {
    const result = normalizeDiagnosticDetail(
      '{"timestamp":"2026-08-24T18:17:43Z","level":"WARN","fields":{"message":"http/request send failed"}}',
    );

    expect(result).toEqual({
      preview: "http/request send failed",
      technicalDetail:
        '{"timestamp":"2026-08-24T18:17:43Z","level":"WARN","fields":{"message":"http/request send failed"}}',
      key: "http/request send failed",
    });
  });

  it("names MCP and worker failures instead of exposing transport noise", () => {
    expect(
      normalizeDiagnosticDetail(
        '{"fields":{"message":"ai-game-developer -> http://localhost:27985 request send failed"}}',
      ),
    ).toMatchObject({
      preview: "ai-game-developer unavailable",
      key: "mcp-unavailable:ai-game-developer",
    });
    expect(normalizeDiagnosticDetail("worker quit with fatal: transport closed")).toMatchObject({
      preview: "Worker stopped unexpectedly",
      key: "worker-stopped",
    });
  });

  it("collapses whitespace and truncates the compact preview", () => {
    const result = normalizeDiagnosticDetail("one\n two\t three", { maxPreviewLength: 10 });
    expect(result?.preview).toBe("one two t…");
  });
});
