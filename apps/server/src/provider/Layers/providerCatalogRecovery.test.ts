import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

const successful = (driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  displayName: driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T19:00:00.000Z",
  models: [{ slug: "known-model", name: "Known model", isCustom: false, capabilities: null }],
  skills: [{ name: "test", description: "Test", path: "/skills/test", enabled: true }],
  slashCommands: [],
});

describe("provider catalog recovery", () => {
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"])(
    "keeps %s models and skills selectable through repeated transient probes",
    (driver) => {
      const previous = successful(driver);
      const failed = {
        ...previous,
        status: "error",
        auth: { status: "unknown" },
        models: [],
        skills: [],
        message: "Probe timed out",
      } as const;
      const pending = mergeProviderSnapshot(previous, {
        ...failed,
        installed: false,
        status: "warning",
      });
      expect(pending.skills).toEqual(previous.skills);
      const retained = mergeProviderSnapshot(pending, failed);
      const repeated = mergeProviderSnapshot(retained, failed);
      expect(repeated.models).toEqual(previous.models);
      expect(repeated.skills).toEqual(previous.skills);
      expect(repeated.status).toBe("warning");
      expect(repeated.message).toContain("showing the last known models");
      expect(mergeProviderSnapshot(repeated, { ...previous, skills: [] }).skills).toEqual([]);
      for (const unavailable of [
        { ...failed, installed: false },
        { ...failed, enabled: false, status: "disabled" as const },
        { ...failed, auth: { status: "unauthenticated" as const } },
      ]) {
        const merged = mergeProviderSnapshot(repeated, unavailable);
        expect(merged.status).toBe(unavailable.status);
        expect(merged.message).toBe(unavailable.message);
      }
      expect(mergeProviderSnapshot(undefined, failed).models).toEqual([]);
    },
  );
});
