import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveEnvironmentSwitchTarget } from "./environmentSwitch.logic";
import { resolveSidebarEnvironmentScope } from "./useSidebarEnvironmentScope";

const elora = EnvironmentId.make("elora");
const millie = EnvironmentId.make("millie");

describe("sidebar environment scope", () => {
  it("defaults to the primary Mac, with a deliberate combined option", () => {
    expect(resolveSidebarEnvironmentScope(null, elora, [elora, millie])).toBe(elora);
    expect(resolveSidebarEnvironmentScope("all", elora, [elora, millie])).toBeNull();
  });

  it("retains a saved remote choice and falls back when that connection disappears", () => {
    expect(resolveSidebarEnvironmentScope(millie, elora, [elora, millie])).toBe(millie);
    expect(resolveSidebarEnvironmentScope(millie, elora, [elora])).toBe(elora);
  });

  it("resumes a remembered thread only while its environment and active shell exist", () => {
    const input = {
      environmentId: elora,
      rememberedLocation: { kind: "thread", environmentId: elora, threadId: "thread-1" } as const,
      connectedEnvironmentIds: [elora, millie],
      threadRefs: [{ environmentId: elora, threadId: "thread-1", archivedAt: null }],
      draftRefs: [],
      recentProjects: [{ environmentId: elora, projectId: "project-1" }],
    };

    expect(resolveEnvironmentSwitchTarget(input)).toEqual({
      kind: "thread",
      environmentId: elora,
      threadId: "thread-1",
    });
    expect(resolveEnvironmentSwitchTarget({ ...input, threadRefs: [] })).toEqual({
      kind: "new-thread",
      environmentId: elora,
      projectId: "project-1",
    });
    expect(
      resolveEnvironmentSwitchTarget({
        ...input,
        threadRefs: [
          {
            environmentId: elora,
            threadId: "thread-1",
            archivedAt: "2026-09-25",
          },
        ],
      }),
    ).toEqual({
      kind: "new-thread",
      environmentId: elora,
      projectId: "project-1",
    });
    expect(
      resolveEnvironmentSwitchTarget({ ...input, rememberedLocation: { kind: "index" } }),
    ).toEqual({ kind: "index" });
    expect(resolveEnvironmentSwitchTarget({ ...input, connectedEnvironmentIds: [millie] })).toEqual(
      { kind: "none" },
    );
  });

  it("resumes an existing draft and uses the most recent project when it is stale", () => {
    const input = {
      environmentId: millie,
      rememberedLocation: { kind: "draft", environmentId: millie, draftId: "draft-1" } as const,
      connectedEnvironmentIds: [elora, millie],
      threadRefs: [],
      draftRefs: [{ environmentId: millie, draftId: "draft-1" }],
      recentProjects: [
        { environmentId: elora, projectId: "other-project" },
        { environmentId: millie, projectId: "most-recent-project" },
        { environmentId: millie, projectId: "older-project" },
      ],
    };

    expect(resolveEnvironmentSwitchTarget(input)).toEqual({ kind: "draft", draftId: "draft-1" });
    expect(resolveEnvironmentSwitchTarget({ ...input, draftRefs: [] })).toEqual({
      kind: "new-thread",
      environmentId: millie,
      projectId: "most-recent-project",
    });
    expect(resolveEnvironmentSwitchTarget({ ...input, draftRefs: [], recentProjects: [] })).toEqual(
      { kind: "index" },
    );
  });

  it("keeps All as a separate mode without inventing a destination", () => {
    const shared = {
      environmentId: null,
      connectedEnvironmentIds: [elora, millie],
      threadRefs: [{ environmentId: millie, threadId: "thread-2", archivedAt: null }],
      draftRefs: [],
      recentProjects: [{ environmentId: elora, projectId: "project-1" }],
    };

    expect(resolveEnvironmentSwitchTarget({ ...shared, rememberedLocation: null })).toEqual({
      kind: "none",
    });
    expect(
      resolveEnvironmentSwitchTarget({
        ...shared,
        rememberedLocation: {
          kind: "thread",
          environmentId: millie,
          threadId: "thread-2",
        },
      }),
    ).toEqual({ kind: "thread", environmentId: millie, threadId: "thread-2" });
    expect(
      resolveEnvironmentSwitchTarget({
        ...shared,
        connectedEnvironmentIds: [elora],
        rememberedLocation: {
          kind: "thread",
          environmentId: millie,
          threadId: "thread-2",
        },
      }),
    ).toEqual({ kind: "none" });
  });
});
