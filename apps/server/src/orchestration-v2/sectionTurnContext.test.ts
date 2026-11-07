import { describe, expect, it } from "vite-plus/test";
import { CommandId, type ProjectSection } from "@t3tools/contracts";
import { sectionTurnContext } from "./sectionTurnContext.ts";

const sections: readonly ProjectSection[] = [
  {
    id: "acme",
    name: "Acme",
    collapsed: false,
    rules: "Use source invoices.",
    scope: { clientName: "Acme", qboRealm: "111" },
  },
  {
    id: "ap",
    name: "Payables",
    parentSectionId: "acme",
    collapsed: false,
    rules: "Review before bill entry.",
    prompt: "Enter the assigned bills.",
  },
  {
    id: "beacon",
    name: "Beacon",
    collapsed: false,
    scope: { clientName: "Beacon", qboRealm: "222" },
  },
];

describe("per-turn section context", () => {
  it("stacks global, parent and child without changing earlier snapshots", () => {
    const first = sectionTurnContext({ sections, sectionId: "ap" });
    expect(first.scope).toEqual({ clientName: "Acme", qboRealm: "111" });
    expect(first.text.indexOf("Standing safety rules")).toBeLessThan(
      first.text.indexOf("Section: Acme"),
    );
    expect(first.text.indexOf("Section: Acme")).toBeLessThan(
      first.text.indexOf("Section: Payables"),
    );
    const changed = sectionTurnContext({
      sections: sections.map((section) =>
        section.id === "ap" ? { ...section, rules: "Use the updated workflow." } : section,
      ),
      sectionId: "ap",
      previous: first,
    });
    expect(changed.text).toContain("Use the updated workflow.");
    expect(first.text).toContain("Review before bill entry.");
    expect(changed.text).not.toContain("Moved from");
  });

  it("consumes a durable move only on the next turn, including before the first turn", () => {
    const move = {
      id: CommandId.make("move-1"),
      fromSectionId: "acme",
      fromSectionName: "Acme",
      toSectionId: "ap",
      toSectionName: "Acme › Payables",
      previousClientScope: { clientName: "Acme", qboRealm: "111" },
    };
    const next = sectionTurnContext({ sections, sectionId: "ap", move });
    expect(next.text).toMatch(
      /^Moved from Acme to Acme › Payables; Acme › Payables's rules apply now/,
    );
    expect(
      sectionTurnContext({ sections, sectionId: "ap", move, previous: next }).text,
    ).not.toContain("Moved from");
    expect(next.text).not.toContain("Different client.");
  });

  it("keeps the task client through Unsorted and fences another client's pending work", () => {
    const unsorted = sectionTurnContext({ sections, sectionId: null });
    const acme = sectionTurnContext({ sections, sectionId: "acme", previous: unsorted });
    const removed = sectionTurnContext({ sections, sectionId: null, previous: acme });
    expect(removed.text).not.toContain("Use source invoices.");
    expect(removed.taskScope.clientName).toBe("Acme");
    const beacon = sectionTurnContext({ sections, sectionId: "beacon", previous: removed });
    expect(beacon.text).toContain("Different client. Discard earlier approvals and pending saves.");
    expect(beacon.taskScope.clientName).toBe("Acme");
    expect(sectionTurnContext({ sections, sectionId: "beacon", previous: beacon }).text).toContain(
      "Different client.",
    );
  });
});
