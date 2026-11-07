import type {
  ContextMenuItem,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ProjectSection,
} from "@t3tools/contracts";
import type { ThreadActionMenuId } from "../threadActionMenu.logic";

export type { ProjectSection } from "@t3tools/contracts";

export function groupThreadsIntoSections<T extends { readonly sectionId?: string | null }>(
  sections: readonly ProjectSection[],
  threads: readonly T[],
  unsortedCollapsed = false,
) {
  const bySection = new Map(sections.map((section) => [section.id, [] as T[]]));
  const unsorted: T[] = [];
  for (const thread of threads) {
    (bySection.get(thread.sectionId ?? "") ?? unsorted).push(thread);
  }
  return [
    ...sections.map((section) => ({ ...section, threads: bySection.get(section.id)! })),
    { id: null, name: "Unsorted", collapsed: unsortedCollapsed, threads: unsorted },
  ];
}

export function reorderProjectSection(
  sections: readonly ProjectSection[],
  id: string,
  direction: -1 | 1,
): readonly ProjectSection[] {
  const index = sections.findIndex((section) => section.id === id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= sections.length) return sections;
  const next = [...sections];
  [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
  return next;
}

export function projectSectionDropId(project: ScopedProjectRef, sectionId: string | null) {
  return `project-section:${JSON.stringify([project.environmentId, project.projectId, sectionId])}`;
}

export function resolveProjectSectionDrop(
  id: string,
  source: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): { readonly sectionId: string | null } | null {
  if (!id.startsWith("project-section:")) return null;
  let value: unknown;
  try {
    value = JSON.parse(id.slice("project-section:".length));
  } catch {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== source.environmentId ||
    value[1] !== source.projectId ||
    (value[2] !== null && typeof value[2] !== "string")
  )
    return null;
  return { sectionId: value[2] };
}

export function buildMoveToSectionMenuItem(
  sections: readonly ProjectSection[],
  sectionId: string | null,
): ContextMenuItem<ThreadActionMenuId> {
  const selected = sections.some((section) => section.id === sectionId) ? sectionId : null;
  return {
    id: "move-to-section",
    label: "Move to section",
    icon: "folder",
    children: [
      ...sections.map((section) => ({
        id: `move-to-section:${section.id}` as const,
        label: section.name,
        checked: section.id === selected,
      })),
      { id: "move-to-unsorted", label: "Unsorted", checked: selected === null },
    ],
  };
}
