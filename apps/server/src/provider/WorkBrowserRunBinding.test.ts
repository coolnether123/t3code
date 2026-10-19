// @effect-diagnostics nodeBuiltinImport:off - Disposable external module fixtures use Node filesystem APIs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";
import { loadWorkBrowserRunBinding } from "./WorkBrowserRunBinding.ts";
import { buildCodexDaemonThreadConfig } from "./Layers/CodexSessionRuntime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function moduleFile(source: string) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-binding-"));
  roots.push(root);
  const path = NodePath.join(root, "binding.mjs");
  await NodeFSP.writeFile(path, source);
  return path;
}

describe("optional work-browser run binding", () => {
  it("leaves an unconfigured provider unchanged", async () => {
    expect(await loadWorkBrowserRunBinding({})).toBeUndefined();
  });
  it("rejects relative paths and malformed owner contracts", async () => {
    await expect(
      loadWorkBrowserRunBinding({ T3_WORK_BROWSER_BINDING: "./relative.mjs" }),
    ).rejects.toThrow("absolute");
    const path = await moduleFile("export const createT3RunBinding = async () => ({begin(){}});");
    await expect(loadWorkBrowserRunBinding({ T3_WORK_BROWSER_BINDING: path })).rejects.toThrow(
      "invalid lifecycle",
    );
  });
  it.effect("binds the same MCP override to desktop-daemon thread configuration", () =>
    Effect.gen(function* () {
      const path = yield* Effect.promise(() =>
        moduleFile(
          [
            "export async function createT3RunBinding({machine, deckTask}) {",
            'if (machine !== "elora" || deckTask !== "fixture-task") throw new Error("Wrong launch binding");',
            'return {appServerArgs: ["-c", \'mcp_servers.work_browser.command="/fixture/node"\',',
            '"-c", \'mcp_servers.work_browser.args=["/fixture/run_client.mjs","/tmp/fixture.sock"]\'],',
            "async begin(runId) {return runId;}, async end(runId,outcome) {return {runId,outcome};}, close(){}};}",
          ].join("\n"),
        ),
      );
      const binding = yield* Effect.promise(() =>
        loadWorkBrowserRunBinding({
          T3_WORK_BROWSER_BINDING: path,
          T3_WORK_BROWSER_MACHINE: "elora",
          T3_WORK_BROWSER_DECK_TASK: "fixture-task",
        }),
      );
      expect(binding).toBeDefined();
      if (!binding) throw new Error("Missing binding");
      expect(yield* Effect.promise(() => binding.begin("fixture-turn"))).toBe("fixture-turn");
      expect(yield* Effect.promise(() => binding.end("fixture-turn", "cancelled"))).toEqual({
        runId: "fixture-turn",
        outcome: "cancelled",
      });
      const config = yield* buildCodexDaemonThreadConfig(binding.appServerArgs, {
        endpoint: "http://127.0.0.1:1/synthetic-mcp",
        authorizationHeader: "Bearer synthetic-fixture",
      });
      expect(config["mcp_servers.work_browser.command"]).toBe("/fixture/node");
      expect(config["mcp_servers.work_browser.args"]).toEqual([
        "/fixture/run_client.mjs",
        "/tmp/fixture.sock",
      ]);
    }),
  );
});
