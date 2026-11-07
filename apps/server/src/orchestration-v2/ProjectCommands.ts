import {
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  type ProjectSection,
  type ProjectSectionHistory,
  ProjectSections,
  validateProjectSections,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectMetaUpdateCommand {
  readonly sections?: ReadonlyArray<ProjectSection>;
  readonly expectedSections?: ReadonlyArray<ProjectSection>;
  readonly unsortedSectionCollapsed?: boolean;
  readonly ensureSection?: ProjectSection;
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export type ProjectCommand = ProjectCreateCommand | ProjectMetaUpdateCommand | ProjectDeleteCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  readonly project: ProjectRow | undefined;
  readonly workspaceOwner: ProjectRow | undefined;
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);
const encodeSections = Schema.encodeSync(ProjectSections);

const normalizedSectionName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function findClientSection(sections: ReadonlyArray<ProjectSection>, clientName: string) {
  const client = normalizedSectionName(clientName);
  const roots = sections.filter((section) => section.parentSectionId === undefined);
  const scoped = roots.find(
    (section) =>
      section.scope?.clientName !== undefined &&
      normalizedSectionName(section.scope.clientName) === client,
  );
  if (scoped !== undefined) return scoped;
  const exact = roots.find((section) => normalizedSectionName(section.name) === client);
  if (exact !== undefined) return exact;
  const matches = roots.filter((section) =>
    ` ${normalizedSectionName(section.name)} `.includes(` ${client} `),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Read state and commit the planned event under the project lock. */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
  readonly actor?: string;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      if (
        command.sections !== undefined &&
        command.ensureSection === undefined &&
        command.expectedSections === undefined &&
        (project.sections ?? []).some(
          (section) =>
            section.parentSectionId !== undefined ||
            section.rules !== undefined ||
            section.prompt !== undefined ||
            section.scope !== undefined,
        )
      ) {
        return invariant(
          "Read the current sections and include expectedSections before saving section rules.",
        );
      }
      if (
        command.expectedSections !== undefined &&
        JSON.stringify(encodeSections(command.expectedSections)) !==
          JSON.stringify(encodeSections(project.sections ?? []))
      ) {
        return invariant("Sections changed since they were read. Read them again before saving.");
      }
      const ensured = command.ensureSection;
      const sections =
        ensured === undefined
          ? command.sections
          : findClientSection(project.sections ?? [], ensured.name) !== undefined
            ? (project.sections ?? [])
            : [...(project.sections ?? []), ensured];
      if (sections !== undefined) {
        const invalid = validateProjectSections(sections);
        if (invalid !== undefined) return invariant(invalid);
      }
      const sectionHistory: ProjectSectionHistory[number][] = [];
      if (sections !== undefined) {
        const previous = new Map((project.sections ?? []).map((section) => [section.id, section]));
        const next = new Map(sections.map((section) => [section.id, section]));
        for (const id of new Set([...previous.keys(), ...next.keys()])) {
          const before = previous.get(id);
          const after = next.get(id);
          const fields = [
            "name",
            "collapsed",
            "parentSectionId",
            "rules",
            "prompt",
            "scope",
          ] as const;
          const changes: Array<ProjectSectionHistory[number]["changes"][number]> = fields.flatMap(
            (field) => {
              const oldValue = JSON.stringify(before?.[field]);
              const newValue = JSON.stringify(after?.[field]);
              return oldValue === newValue
                ? []
                : [
                    {
                      field,
                      ...(oldValue === undefined ? {} : { before: oldValue }),
                      ...(newValue === undefined ? {} : { after: newValue }),
                    },
                  ];
            },
          );
          if (before !== undefined && after !== undefined && previous.size === next.size) {
            const oldIndex = (project.sections ?? []).findIndex((section) => section.id === id);
            const newIndex = sections.findIndex((section) => section.id === id);
            if (oldIndex !== newIndex)
              changes.push({
                field: "position",
                before: String(oldIndex),
                after: String(newIndex),
              });
          }
          if (changes.length > 0)
            sectionHistory.push({
              id: `${input.eventId}:${id}`,
              sectionId: id,
              actor: input.actor ?? "server",
              createdAt: occurredAt,
              changes,
            });
        }
      }
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.scripts !== undefined) {
        // Allow editing or removing persisted invalid script ids, while rejecting new invalid ids.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(sections === undefined ? {} : { sections }),
          ...(sectionHistory.length === 0 ? {} : { sectionHistory }),
          ...(command.unsortedSectionCollapsed === undefined
            ? {}
            : { unsortedSectionCollapsed: command.unsortedSectionCollapsed }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          // Repeating a pin or archive keeps the original time.
          ...(command.pinned === undefined
            ? {}
            : { pinnedAt: command.pinned ? (project.pinnedAt ?? occurredAt) : null }),
          ...(command.archived === undefined
            ? {}
            : { archivedAt: command.archived ? (project.archivedAt ?? occurredAt) : null }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}
