import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  groupThreadsIntoSections,
  projectSectionDropId,
  reorderProjectSection,
  resolveProjectSectionDrop,
} from "./projectSections.logic";

const sections = [
  { id: "b", name: "Second client", collapsed: true },
  { id: "a", name: "First client", collapsed: false },
];

describe("project sections", () => {
  it("keeps the user's order and groups deleted or missing assignments into Unsorted last", () => {
    const threads = [
      { id: "one", sectionId: "a" },
      { id: "two", sectionId: "deleted" },
      { id: "three", sectionId: null },
      { id: "four", sectionId: "b" },
    ];
    const grouped = groupThreadsIntoSections(sections, threads);
    expect(groupThreadsIntoSections(sections, threads, true).at(-1)?.collapsed).toBe(true);
    expect(grouped.map(({ id, threads }) => [id, threads.map((thread) => thread.id)])).toEqual([
      ["b", ["four"]],
      ["a", ["one"]],
      [null, ["two", "three"]],
    ]);
    expect(
      groupThreadsIntoSections(
        sections.filter(({ id }) => id !== "a"),
        threads,
      ).at(-1)?.threads,
    ).toEqual(threads.slice(0, 3));
  });

  it("reorders within bounds without changing section contents", () => {
    expect(reorderProjectSection(sections, "a", -1)).toEqual([sections[1], sections[0]]);
    expect(reorderProjectSection(sections, "b", -1)).toBe(sections);
    expect(reorderProjectSection(sections, "missing", 1)).toBe(sections);
    const nested = [
      ...sections,
      { id: "child", name: "Payables", collapsed: false, parentSectionId: "b" },
      { id: "other-child", name: "Receivables", collapsed: false, parentSectionId: "b" },
    ];
    expect(reorderProjectSection(nested, "child", -1)).toBe(nested);
    const reordered = reorderProjectSection(nested, "child", 1);
    expect(reordered.map((section) => section.id)).toEqual(["b", "a", "other-child", "child"]);
    expect(groupThreadsIntoSections(reordered, []).map((group) => group.id)).toEqual([
      "b",
      "other-child",
      "child",
      "a",
      null,
    ]);
  });

  it("accepts moves only within the same project and environment, including Unsorted", () => {
    const source = {
      environmentId: EnvironmentId.make("elora"),
      projectId: ProjectId.make("workroom"),
    };
    expect(resolveProjectSectionDrop(projectSectionDropId(source, "a"), source)).toEqual({
      sectionId: "a",
    });
    expect(resolveProjectSectionDrop(projectSectionDropId(source, null), source)).toEqual({
      sectionId: null,
    });
    expect(
      resolveProjectSectionDrop(
        projectSectionDropId({ ...source, environmentId: EnvironmentId.make("millie") }, "a"),
        source,
      ),
    ).toBeNull();
    expect(
      resolveProjectSectionDrop(
        projectSectionDropId({ ...source, projectId: ProjectId.make("other") }, "a"),
        source,
      ),
    ).toBeNull();
    expect(resolveProjectSectionDrop("project-section:bad-json", source)).toBeNull();
  });
});
