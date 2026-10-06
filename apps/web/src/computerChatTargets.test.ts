import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { newThreadProjectTargets } from "./sidebarProjectGrouping";
import { buildProjectActionItems } from "./components/CommandPalette.logic";
import type { Project } from "./types";

const computerA = EnvironmentId.make("computer-a");
const computerB = EnvironmentId.make("computer-b");
const projects: ReadonlyArray<Project> = [computerA, computerB].map((environmentId) => ({
  environmentId,
  id: ProjectId.make("workroom"),
  title: "Workroom",
  workspaceRoot: "/Users/example/Workroom",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-06T06:00:00.000Z",
  updatedAt: "2026-10-06T06:00:00.000Z",
}));

describe("computer chat targets", () => {
  it("lists both computers in All computers even with identical project names and paths", async () => {
    const runProject = vi.fn(async (_project: Project) => {});
    const items = buildProjectActionItems({
      projects: newThreadProjectTargets(projects, null),
      valuePrefix: "new-thread-in",
      icon: () => null,
      runProject,
    });
    expect(items.map((item) => item.value)).toEqual([
      "new-thread-in:computer-a:workroom",
      "new-thread-in:computer-b:workroom",
    ]);
    await items[1]!.run();
    expect(runProject).toHaveBeenCalledWith(projects[1]);
    expect(runProject).toHaveBeenCalledTimes(1);
  });

  it("limits New to the selected computer and handles an empty computer", () => {
    expect(newThreadProjectTargets(projects, computerB)).toEqual([projects[1]]);
    expect(newThreadProjectTargets(projects, EnvironmentId.make("empty-computer"))).toEqual([]);
  });
});
