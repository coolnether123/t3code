import { useDroppable } from "@dnd-kit/core";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { ChevronDownIcon, InfoIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn, randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  groupThreadsIntoSections,
  projectSectionDropId,
  reorderProjectSection,
  type ProjectSection,
} from "./projectSections.logic";

export interface SidebarProjectSectionsProps {
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly canUpdate: (project: ScopedProjectRef) => boolean;
  readonly onUpdate: (
    project: ScopedProjectRef,
    sections: readonly ProjectSection[],
    unsortedSectionCollapsed?: boolean,
  ) => Promise<boolean>;
  readonly renderThread: (thread: EnvironmentThreadShell, parent: string) => ReactNode;
  readonly onOpenSection: (project: ScopedProjectRef, section: ProjectSection) => void;
  readonly canNest?: (project: ScopedProjectRef) => boolean;
}

function SectionGroup(props: {
  readonly project: ScopedProjectRef;
  readonly section: ProjectSection | null;
  readonly canUpdate: boolean;
  readonly count: number;
  readonly collapsed: boolean;
  readonly children: ReactNode;
  readonly onToggle: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  readonly onReorder: (direction: -1 | 1) => void;
  readonly onOpen: () => void;
  readonly onCreateChild: (() => void) | undefined;
  readonly first: boolean;
  readonly last: boolean;
}) {
  const name = props.section?.name ?? "Unsorted";
  const collapsed = props.collapsed;
  const id = projectSectionDropId(props.project, props.section?.id ?? null);
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !props.canUpdate });
  return (
    <li
      ref={setNodeRef}
      data-project-section={props.section?.id ?? "unsorted"}
      className={cn("rounded-md pb-1", isOver && "bg-primary/10 ring-1 ring-primary/40")}
    >
      <div className="flex min-h-8 items-center gap-1 px-1">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${name} section`}
          aria-expanded={!collapsed}
          onClick={props.onToggle}
          disabled={!props.canUpdate}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0", collapsed && "-rotate-90")}
          />
        </Button>
        <button
          type="button"
          data-sidebar-row={id}
          aria-label={`${name} section`}
          onClick={props.section ? props.onOpen : props.onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-xs font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span className="text-3xs tabular-nums">{props.count}</span>
        </button>
        {props.section ? (
          <>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`About ${name} section`}
              onClick={props.onOpen}
            >
              <InfoIcon aria-hidden />
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Manage ${name} section`}
                    disabled={!props.canUpdate}
                  />
                }
              >
                <MoreHorizontalIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={props.onRename}>Rename section</MenuItem>
                {props.onCreateChild ? (
                  <MenuItem onClick={props.onCreateChild}>Create child section</MenuItem>
                ) : null}
                <MenuItem disabled={props.first} onClick={() => props.onReorder(-1)}>
                  Move section up
                </MenuItem>
                <MenuItem disabled={props.last} onClick={() => props.onReorder(1)}>
                  Move section down
                </MenuItem>
                <MenuItem variant="destructive" onClick={props.onDelete}>
                  Delete section
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        ) : null}
      </div>
      {!collapsed ? (
        <ul role="presentation" className="flex min-h-3 flex-col gap-px">
          {props.children}
        </ul>
      ) : null}
    </li>
  );
}

type Editor = {
  readonly project: EnvironmentProject;
  readonly section: ProjectSection | null;
  readonly deleting: boolean;
  readonly parentSectionId?: string;
};

export function SidebarProjectSections(props: SidebarProjectSectionsProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startEdit = (
    project: EnvironmentProject,
    section: ProjectSection | null,
    deleting = false,
    parentSectionId?: string,
  ) => {
    setEditor({ project, section, deleting, ...(parentSectionId ? { parentSectionId } : {}) });
    setName(section?.name ?? "");
    setError(null);
  };
  const save = async () => {
    if (editor === null || saving) return;
    const project = props.projects.find(
      (candidate) =>
        candidate.environmentId === editor.project.environmentId &&
        candidate.id === editor.project.id,
    );
    if (!project) return;
    const sections = project.sections ?? [];
    const trimmed = name.trim();
    if (
      !editor.deleting &&
      (!trimmed ||
        sections.some(
          (section) =>
            section.id !== editor.section?.id &&
            section.parentSectionId ===
              (editor.section?.parentSectionId ?? editor.parentSectionId) &&
            section.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
        ))
    ) {
      setError(trimmed ? "A section with that name already exists." : "Enter a section name.");
      return;
    }
    const next = editor.deleting
      ? sections
          .filter((section) => section.id !== editor.section?.id)
          .map((section) =>
            section.parentSectionId === editor.section?.id
              ? { ...section, parentSectionId: undefined }
              : section,
          )
      : editor.section
        ? sections.map((section) =>
            section.id === editor.section?.id ? { ...section, name: trimmed } : section,
          )
        : [
            ...sections,
            {
              id: randomUUID(),
              name: trimmed,
              collapsed: false,
              ...(editor.parentSectionId ? { parentSectionId: editor.parentSectionId } : {}),
            },
          ];
    setSaving(true);
    const saved = await props.onUpdate(scopeProjectRef(project.environmentId, project.id), next);
    setSaving(false);
    if (saved) setEditor(null);
  };
  return (
    <>
      {props.projects.map((project) => {
        const projectRef = scopeProjectRef(project.environmentId, project.id);
        const sections = project.sections ?? [];
        const groups = groupThreadsIntoSections(
          sections,
          props.threads.filter(
            (thread) =>
              thread.environmentId === project.environmentId && thread.projectId === project.id,
          ),
          project.unsortedSectionCollapsed ?? false,
        );
        const canUpdate = props.canUpdate(projectRef);
        const renderGroup = (group: (typeof groups)[number]): ReactNode => {
          const section =
            group.id === null ? null : sections.find((entry) => entry.id === group.id)!;
          const children = section
            ? groups.filter(
                (entry) =>
                  entry.id !== null &&
                  "parentSectionId" in entry &&
                  entry.parentSectionId === section.id,
              )
            : [];
          const siblings = sections.filter(
            (entry) => entry.parentSectionId === section?.parentSectionId,
          );
          const siblingIndex = siblings.findIndex((entry) => entry.id === section?.id);
          const parent = projectSectionDropId(projectRef, group.id);
          return (
            <SectionGroup
              key={group.id ?? "unsorted"}
              project={projectRef}
              section={section}
              canUpdate={canUpdate}
              count={
                group.threads.length +
                children.reduce((count, entry) => count + entry.threads.length, 0)
              }
              collapsed={group.collapsed}
              first={siblingIndex === 0}
              last={siblingIndex === siblings.length - 1}
              onOpen={() => {
                if (section) props.onOpenSection(projectRef, section);
              }}
              onCreateChild={
                section && !section.parentSectionId && props.canNest?.(projectRef)
                  ? () => startEdit(project, null, false, section.id)
                  : undefined
              }
              onToggle={() => {
                void props.onUpdate(
                  projectRef,
                  section
                    ? sections.map((candidate) =>
                        candidate.id === section.id
                          ? { ...candidate, collapsed: !candidate.collapsed }
                          : candidate,
                      )
                    : sections,
                  section ? undefined : !group.collapsed,
                );
              }}
              onRename={() => startEdit(project, section)}
              onDelete={() => startEdit(project, section, true)}
              onReorder={(direction) => {
                if (section)
                  void props.onUpdate(
                    projectRef,
                    reorderProjectSection(sections, section.id, direction),
                  );
              }}
            >
              {group.threads.map((thread) => props.renderThread(thread, parent))}
              {children.length ? (
                <li role="presentation" className="ml-3 border-l border-sidebar-border pl-1">
                  <ul role="presentation">{children.map(renderGroup)}</ul>
                </li>
              ) : null}
            </SectionGroup>
          );
        };
        return (
          <li key={`${project.environmentId}:${project.id}`} className="pt-2">
            <div className="flex items-center gap-1 px-2 pb-1">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
                {project.title}
              </span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Create section in ${project.title}`}
                disabled={!canUpdate}
                onClick={() => startEdit(project, null)}
              >
                <PlusIcon aria-hidden />
              </Button>
            </div>
            <ul role="presentation" className="flex flex-col gap-px">
              {groups
                .filter((group) => !("parentSectionId" in group) || !group.parentSectionId)
                .map(renderGroup)}
            </ul>
          </li>
        );
      })}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditor(null);
        }}
      >
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editor?.deleting
                  ? "Delete section?"
                  : editor?.section
                    ? "Rename section"
                    : "Create section"}
              </DialogTitle>
              <DialogDescription>
                {editor?.deleting
                  ? `Chats in ${editor.section?.name} will move to Unsorted. Child sections become top-level sections. No chats will be deleted.`
                  : "Group chats within this project. Changes appear on every connected device."}
              </DialogDescription>
            </DialogHeader>
            {!editor?.deleting ? (
              <div className="px-6 pb-4">
                <Input
                  aria-label="Section name"
                  autoFocus
                  maxLength={100}
                  value={name}
                  disabled={saving}
                  onChange={(event) => setName(event.target.value)}
                />
                {error ? (
                  <p role="alert" className="mt-2 text-xs text-error">
                    {error}
                  </p>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={saving} />}>
                Cancel
              </DialogClose>
              <Button
                type="submit"
                variant={editor?.deleting ? "destructive" : "default"}
                disabled={saving}
              >
                {saving ? "Saving…" : editor?.deleting ? "Delete section" : "Save section"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
