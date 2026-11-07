import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  renderProjectSectionRules,
  resolveProjectSectionContext,
  validateProjectSections,
  type ProjectSection,
  type ProjectSectionScope,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useProject, useQuietThreadShells, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const scopeFields = [
  ["clientName", "Company"],
  ["qboRealm", "QBO company number"],
  ["microsoftProfileCode", "Microsoft profile"],
  ["mailbox", "Mailbox"],
  ["doubleClientId", "Double client"],
] as const;

const historyLabels: Record<string, string> = {
  name: "Name",
  collapsed: "Collapsed",
  parentSectionId: "Parent section",
  rules: "Rules",
  prompt: "Prompt",
  scope: "Client details",
  order: "Section order",
  standingDecisions: "Standing decisions",
  ...Object.fromEntries(scopeFields),
};

function historyValue(
  text: string | undefined,
  field: string,
  sections: readonly ProjectSection[],
): string {
  if (text === undefined) return "Not set";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof value === "string")
    return field === "parentSectionId"
      ? (sections.find((section) => section.id === value)?.name ?? value)
      : value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value && typeof value === "object" && !Array.isArray(value))
    return Object.entries(value)
      .map(
        ([key, entry]) =>
          `${historyLabels[key] ?? key}: ${Array.isArray(entry) ? entry.join("; ") : String(entry ?? "Not set")}`,
      )
      .join("\n");
  return String(value ?? "Not set");
}

function historyActor(actor: string): string {
  if (actor === "server") return "Server";
  if (actor.startsWith("user:")) return `User · ${actor.slice(5)}`;
  if (actor.startsWith("agent:")) return `Agent · ${actor.slice(6)}`;
  return actor;
}

function ScopeDetails({ scope }: { scope: ProjectSectionScope }) {
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {scopeFields.map(([field, label]) => (
        <div key={field} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{scope[field] || "Not set"}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionEditor({
  project,
  section,
  canEdit,
}: {
  project: EnvironmentProject;
  section: ProjectSection;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<{ base: string; value: ProjectSection } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const value = draft?.value ?? section;
  const changedElsewhere = draft !== null && draft.base !== JSON.stringify(section);
  const hasChildren = (project.sections ?? []).some(
    (entry) => entry.parentSectionId === section.id,
  );
  const parentChoices = (project.sections ?? []).filter(
    (entry) => entry.id !== section.id && !entry.parentSectionId,
  );
  const parentScope = parentChoices.find((entry) => entry.id === value.parentSectionId)?.scope;
  const edit = (patch: Partial<ProjectSection>) => {
    setDraft({ base: draft?.base ?? JSON.stringify(section), value: { ...value, ...patch } });
    setNotice(null);
  };
  const editScope = (field: keyof ProjectSectionScope, text: string) => {
    edit({ scope: { ...value.scope, [field]: text } });
  };
  const save = async () => {
    if (!canEdit || !draft || saving || changedElsewhere) return;
    setNotice(null);
    const scope = {
      ...Object.fromEntries(
        scopeFields.map(([field]) => [field, value.scope?.[field]?.trim() || undefined]),
      ),
      standingDecisions: value.scope?.standingDecisions?.map((line) => line.trim()).filter(Boolean),
    };
    const next = { ...value, scope };
    const sections = (project.sections ?? []).map((entry) =>
      entry.id === section.id ? next : entry,
    );
    const invalid = validateProjectSections(sections);
    if (invalid) {
      setNotice(invalid);
      return;
    }
    setSaving(true);
    const result = await updateProject({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        expectedSections: project.sections ?? [],
        sections,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(null);
      setNotice("Section saved. The new rules apply on the next turn.");
    } else setNotice("The section could not be saved. Your changes are still here.");
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex min-w-0 flex-col gap-4"
    >
      <h3 className="text-sm font-medium">Edit section</h3>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        Parent section
        <Select
          value={value.parentSectionId ?? ""}
          disabled={!canEdit || saving || hasChildren}
          onValueChange={(parentSectionId) =>
            edit({ parentSectionId: parentSectionId || undefined })
          }
        >
          <SelectTrigger aria-label="Parent section">
            <SelectValue>
              {(selected) =>
                parentChoices.find((entry) => entry.id === selected)?.name ?? "No parent"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">No parent</SelectItem>
            {parentChoices.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {hasChildren ? (
          <span className="text-xs text-muted-foreground">
            A section with children must stay at the top level.
          </span>
        ) : null}
      </label>
      {scopeFields.map(([field, label]) => (
        <label key={field} className="flex min-w-0 flex-col gap-1 text-sm">
          {label}
          <Input
            aria-label={label}
            value={value.scope?.[field] ?? ""}
            maxLength={512}
            placeholder={parentScope?.[field] ? `Inherited: ${parentScope[field]}` : undefined}
            disabled={!canEdit || saving}
            onChange={(event) => editScope(field, event.target.value)}
          />
        </label>
      ))}
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        Standing decisions
        <Textarea
          aria-label="Standing decisions"
          rows={3}
          value={value.scope?.standingDecisions?.join("\n") ?? ""}
          disabled={!canEdit || saving}
          onChange={(event) =>
            edit({ scope: { ...value.scope, standingDecisions: event.target.value.split("\n") } })
          }
        />
        <span className="text-xs text-muted-foreground">
          One decision per line. Blank fields inherit the parent's details.
        </span>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        Rules
        <Textarea
          aria-label="Section rules"
          rows={6}
          maxLength={32000}
          value={value.rules ?? ""}
          disabled={!canEdit || saving}
          onChange={(event) => edit({ rules: event.target.value })}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        Prompt
        <Textarea
          aria-label="Section prompt"
          rows={5}
          maxLength={32000}
          value={value.prompt ?? ""}
          disabled={!canEdit || saving}
          onChange={(event) => edit({ prompt: event.target.value })}
        />
      </label>
      {!canEdit ? (
        <p className="text-xs text-muted-foreground">
          This connection can view sections but cannot edit them.
        </p>
      ) : null}
      {changedElsewhere ? (
        <p role="alert" className="text-sm text-error">
          This section changed on another device. Copy any changes you want to keep, then reload the
          saved version.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!canEdit || !draft || saving || changedElsewhere}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {draft ? (
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setNotice(null);
            }}
          >
            {changedElsewhere ? "Reload saved version" : "Discard changes"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function SectionPanel({
  projectRef,
  sectionId,
}: {
  projectRef: ScopedProjectRef;
  sectionId: string;
}) {
  const project = useProject(projectRef);
  const threads = useQuietThreadShells();
  const configs = useServerConfigs();
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const router = useRouter();
  const section = project?.sections?.find((entry) => entry.id === sectionId);
  if (!project || !section)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        This section is no longer available.
      </p>
    );
  const context = resolveProjectSectionContext(project.sections ?? [], sectionId);
  const chats = threads.filter(
    (thread) =>
      thread.environmentId === project.environmentId &&
      thread.projectId === project.id &&
      thread.sectionId === section.id,
  );
  const history = (project.sectionHistory ?? [])
    .filter((entry) => entry.sectionId === sectionId)
    .toReversed();
  const supported =
    configs.get(project.environmentId)?.environment.capabilities.projectSectionRules === true;
  const canEdit = canOperate && supported;
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain"
      data-section-panel={sectionId}
    >
      <div className="flex flex-col gap-6 p-4 pb-8">
        <header className="min-w-0">
          <p className="text-xs text-muted-foreground">Section · {project.title}</p>
          <h2 className="break-words text-lg font-medium">
            {context.sections.map((entry) => entry.name).join(" › ")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Rules apply when a chat's next turn starts. Running work is not interrupted.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Section rules currently run with Codex. Other providers cannot start sectioned chats
            yet.
          </p>
        </header>
        {!supported ? (
          <p role="status" className="text-sm text-muted-foreground">
            Update this environment to edit section rules. This server only supports basic sections.
          </p>
        ) : null}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Client details</h3>
          <ScopeDetails scope={context.scope} />
        </section>
        <SectionEditor
          key={`${project.environmentId}:${project.id}:${sectionId}`}
          project={project}
          section={section}
          canEdit={canEdit}
        />
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Combined section rules</h3>
          <p className="text-xs text-muted-foreground">
            Global guide → {context.sections.map((entry) => entry.name).join(" → ")}. Section rules
            cannot weaken the global safety rules.
          </p>
          <p className="text-xs text-muted-foreground">
            This section context is sent with each turn. The workspace guide and other agent
            instructions also remain in force.
          </p>
          <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-sans text-xs leading-relaxed">
            {renderProjectSectionRules(project.sections ?? [], sectionId)}
          </pre>
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Edit history</h3>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No recorded edits.</p>
          ) : (
            <ol className="space-y-3">
              {history.map((entry) => (
                <li key={entry.id} className="min-w-0 rounded-md border p-3 text-xs">
                  <p className="break-words font-medium">
                    {historyActor(entry.actor)} ·{" "}
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </p>
                  <ul className="mt-2 space-y-2">
                    {entry.changes.map((change) => (
                      <li key={change.field} className="break-words">
                        <p className="font-medium">{historyLabels[change.field] ?? change.field}</p>
                        <p className="whitespace-pre-wrap text-muted-foreground">
                          Before:{" "}
                          {historyValue(change.before, change.field, project.sections ?? [])}
                        </p>
                        <p className="whitespace-pre-wrap">
                          After: {historyValue(change.after, change.field, project.sections ?? [])}
                        </p>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Chats in this section</h3>
          {chats.length ? (
            <ul className="space-y-1">
              {chats.map((thread) => (
                <li key={thread.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-w-full"
                    onClick={() => {
                      void router.navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(thread.environmentId, thread.id),
                        ),
                      });
                    }}
                  >
                    <span className="min-w-0 truncate">{thread.title}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No chats in this section.</p>
          )}
        </section>
      </div>
    </div>
  );
}
