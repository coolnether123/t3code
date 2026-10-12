import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { importCodexSidebarSections, moveThreadToSidebarSection } from "./sidebarSections.ts";
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const source = (sections: unknown[], sectionOrder = ["a", "b"], collapsedSectionIds = ["a"]) => ({
  "electron-persisted-atom-state": {
    "sidebar-custom-sections-v3": {
      account: { sections, sectionOrder, collapsedSectionIds },
    },
  },
});
const section = (id: string, itemKeys: string[]) => ({
  id,
  name: `Client ${id}`,
  itemKeys,
  appearance: { color: "#ff5500", icon: "📁" },
});
describe("sidebar sections", () => {
  it("preserves source order, collapse, appearance and exact cross-project matches", () => {
    const raw = source([
      section("b", ["codex:thread:local:provider-2"]),
      section("a", ["codex:thread:local:t3-1"]),
    ]);
    const before = JSON.stringify(raw);
    const plan = importCodexSidebarSections(raw, [
      { threadId: "t3-1", codexIds: [] },
      { threadId: "t3-2", codexIds: ["provider-2"] },
    ]);
    expect(plan.sections.map((entry) => entry.name)).toEqual(["Client a", "Client b"]);
    expect(plan.sections[0]).toMatchObject({
      collapsed: true,
      threadIds: ["t3-1"],
      appearance: { color: "#ff5500" },
    });
    expect(plan.sections[1]?.threadIds).toEqual(["t3-2"]);
    expect(plan.codexImport).toMatchObject({ matchedCount: 2, unmatchedCount: 0 });
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("does not guess missing, foreign-host or ambiguous chat identities", () => {
    const plan = importCodexSidebarSections(
      source([
        section("a", [
          "codex:thread:local:missing",
          "codex:thread:remote:known",
          "codex:thread:local:duplicate",
        ]),
      ]),
      [
        { threadId: "one", codexIds: ["duplicate", "known"] },
        { threadId: "two", codexIds: ["duplicate"] },
      ],
    );
    expect(plan.sections[0]?.threadIds).toEqual([]);
    expect(plan.codexImport).toMatchObject({
      matchedCount: 0,
      unmatchedCount: 3,
      ambiguousCount: 1,
    });
  });
  it("deduplicates assignments by source section order", () => {
    const plan = importCodexSidebarSections(
      source([section("a", ["codex:thread:local:one"]), section("b", ["codex:thread:local:one"])]),
      [{ threadId: "one", codexIds: [] }],
    );
    expect(plan.sections.map((entry) => entry.threadIds)).toEqual([["one"], []]);
    expect(plan.codexImport?.duplicateCount).toBe(1);
  });
  it("moves a chat to exactly one section, or back out, without altering its identity", () => {
    const original = {
      sections: [
        { id: "a", name: "A", collapsed: false, threadIds: ["one"] },
        { id: "b", name: "B", collapsed: false, threadIds: [] },
      ],
    };
    const moved = moveThreadToSidebarSection(original, "one", "b");
    expect(moved.sections.map((entry) => entry.threadIds)).toEqual([[], ["one"]]);
    expect(
      moveThreadToSidebarSection(moved, "one", null).sections.map((entry) => entry.threadIds),
    ).toEqual([[], []]);
    expect(original.sections[0]?.threadIds).toEqual(["one"]);
    expect(() => moveThreadToSidebarSection(original, "one", "missing")).toThrow();
  });
  it("decodes old settings unchanged and rejects multiple memberships", () => {
    expect(decodeSettings({}).sidebarSections).toBeUndefined();
    expect(() =>
      decodePatch({
        sidebarSections: {
          sections: [
            { id: "a", name: "A", collapsed: false, threadIds: ["one"] },
            { id: "b", name: "B", collapsed: false, threadIds: ["one"] },
          ],
        },
      }),
    ).toThrow();
  });
  it("refuses ambiguous accounts instead of importing another person's sections", () => {
    const raw = source([section("a", [])]);
    Object.assign(raw["electron-persisted-atom-state"]["sidebar-custom-sections-v3"], {
      other: raw["electron-persisted-atom-state"]["sidebar-custom-sections-v3"].account,
    });
    expect(() => importCodexSidebarSections(raw, [])).toThrow(/ambiguous/);
  });
});
