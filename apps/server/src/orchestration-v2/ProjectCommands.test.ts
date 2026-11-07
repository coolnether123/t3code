import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  type ProjectScript,
  type ProjectSection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  findClientSection,
  planProjectCommand,
  type ProjectCommand,
  type ProjectCommandState,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("allows one parent level, inherits client scope, and audits changes without trusting submitted history", () => {
    const parent: ProjectSection = {
      id: "ita",
      name: "IT Ally",
      collapsed: false,
      scope: { clientName: "IT Ally", qboRealm: "9130349943358106" },
    };
    const child: ProjectSection = {
      id: "ap",
      name: "Payables",
      collapsed: false,
      parentSectionId: "ita",
      rules: "Review invoices first.",
    };
    const update = (sections: readonly ProjectSection[]) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("section-rules"),
          projectId,
          sections,
          expectedSections: [parent],
        },
        { project: row({ sections: [parent] }) },
      );
    const payload = payloadOf(update([parent, child]));
    assert.deepEqual(payload.sections, [parent, child]);
    const otherParent = { id: "gazelle", name: "Gazelle", collapsed: false };
    assert.deepEqual(
      payloadOf(
        update([
          parent,
          child,
          otherParent,
          { ...child, id: "gazelle-ap", parentSectionId: "gazelle" },
        ]),
      ).sections,
      [parent, child, otherParent, { ...child, id: "gazelle-ap", parentSectionId: "gazelle" }],
    );
    assert.deepInclude((payload.sectionHistory as readonly Record<string, unknown>[])[0], {
      sectionId: "ap",
      actor: "server",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const oldClient = plan(
      {
        type: "project.meta.update",
        commandId: CommandId.make("old-client"),
        projectId,
        sections: [{ id: parent.id, name: parent.name, collapsed: true }],
      },
      { project: row({ sections: [parent] }) },
    );
    assert.include(failureOf(oldClient).message, "include expectedSections");
    for (const sections of [
      [parent, { ...child, parentSectionId: "missing" }],
      [parent, { ...child, parentSectionId: "ap" }],
      [{ ...parent, parentSectionId: "ap" }, child],
      [parent, child, { ...child, id: "deep", name: "Deep", parentSectionId: "ap" }],
      [parent, { ...child, scope: { clientName: "Gazelle" } }],
      [parent, { ...child, scope: { clientName: "IT Ally", qboRealm: "9130348821693276" } }],
      [
        { ...parent, scope: { qboRealm: "9130349943358106" } },
        { ...child, scope: { qboRealm: "9130348821693276" } },
      ],
      [
        { ...parent, scope: { microsoftProfileCode: "ITA" } },
        { ...child, scope: { microsoftProfileCode: "GAZ" } },
      ],
      [
        { ...parent, scope: { mailbox: "ita@example.test" } },
        { ...child, scope: { mailbox: "gazelle@example.test" } },
      ],
      [
        { ...parent, scope: { doubleClientId: "ita" } },
        { ...child, scope: { doubleClientId: "gazelle" } },
      ],
    ])
      assert.equal(failureOf(update(sections))._tag, "ProjectCommandInvariantError");
  });

  it("keeps named sections ordered and validates identities before persisting", () => {
    const ita = { id: "ita", name: "HT ITA IT Ally", collapsed: false };
    const amorso = { id: "amorso", name: "HT AHS Amorso", collapsed: true };
    const update = (sections: ReadonlyArray<typeof ita>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("sections"),
          projectId,
          sections,
        },
        { project: row({ sections: [ita, amorso] }) },
      );
    assert.deepEqual(
      payloadOf(update([amorso, { ...ita, name: "IT Ally", collapsed: true }])).sections,
      [amorso, { ...ita, name: "IT Ally", collapsed: true }],
    );
    for (const sections of [
      [ita, ita],
      [ita, { ...amorso, name: "ht ita it ally" }],
      [{ ...ita, name: " " }],
    ]) {
      assert.equal(failureOf(update(sections))._tag, "ProjectCommandInvariantError");
    }
    assert.deepEqual(payloadOf(update([])).sections, []);
    assert.equal(findClientSection([ita, amorso], "IT Ally")?.id, "ita");
    assert.equal(findClientSection([ita, amorso], "AMORSO")?.id, "amorso");
    assert.isUndefined(findClientSection([ita, { ...amorso, name: "Other IT Ally" }], "IT Ally"));
    assert.isUndefined(findClientSection([ita], "All"));
    const ensured = payloadOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("auto-section"),
          projectId,
          ensureSection: { ...ita, id: "new", name: "IT Ally" },
        },
        { project: row({ sections: [ita] }) },
      ),
    );
    assert.deepEqual(ensured.sections, [ita]);
  });
  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("keeps the first pin and archive time, and clears both on undo", () => {
    const earlier = "2025-12-01T00:00:00.000Z";
    const update = (project: ProjectRow, change: { pinned?: boolean; archived?: boolean }) =>
      payloadOf(
        plan(
          {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-organize"),
            projectId,
            ...change,
          },
          { project },
        ),
      );
    assert.deepInclude(update(row(), { pinned: true, archived: true }), {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    const organized = row({ pinnedAt: earlier, archivedAt: earlier });
    assert.deepInclude(update(organized, { pinned: true, archived: true }), {
      pinnedAt: earlier,
      archivedAt: earlier,
    });
    assert.deepInclude(update(organized, { pinned: false, archived: false }), {
      pinnedAt: null,
      archivedAt: null,
    });
    const untouched = update(organized, {});
    assert.notProperty(untouched, "pinnedAt");
    assert.notProperty(untouched, "archivedAt");
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });
});
