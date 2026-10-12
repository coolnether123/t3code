import type { SidebarSection, SidebarSections } from "@t3tools/contracts";

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex section state");
  }
  return value as Record<string, unknown>;
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid Codex section list");
  }
  return value;
};

/** Exact identities only. An ambiguous provider identity is never assigned. */
export function importCodexSidebarSections(
  raw: unknown,
  identities: ReadonlyArray<{ threadId: string; codexIds: ReadonlyArray<string> }>,
): SidebarSections {
  const persisted = object(object(raw)["electron-persisted-atom-state"]);
  const accounts = object(persisted["sidebar-custom-sections-v3"]);
  const candidates = Object.values(accounts)
    .map(object)
    .filter((account) => Array.isArray(account.sections) && account.sections.length > 0);
  if (candidates.length !== 1) throw new Error("Codex section account is unavailable or ambiguous");
  const account = candidates[0]!;
  const sections = (account.sections as unknown[]).map(object);
  const order = strings(account.sectionOrder);
  const collapsed = new Set(strings(account.collapsedSectionIds));
  const ids = sections.map((section) => section.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw new Error("Invalid Codex section identities");
  }
  const byId = new Map(sections.map((section) => [section.id, section]));
  const ordered = [...new Set([...order, ...(ids as string[])])].flatMap((id) => {
    const section = byId.get(id);
    return section ? [section] : [];
  });
  const matches = new Map<string, Set<string>>();
  for (const identity of identities) {
    for (const id of [identity.threadId, ...identity.codexIds]) {
      const existing = matches.get(id) ?? new Set<string>();
      existing.add(identity.threadId);
      matches.set(id, existing);
    }
  }
  const assigned = new Set<string>();
  const counts = {
    sectionCount: ordered.length,
    matchedCount: 0,
    unmatchedCount: 0,
    ambiguousCount: 0,
    duplicateCount: 0,
  };
  const imported: SidebarSection[] = ordered.map((section) => {
    if (typeof section.name !== "string" || !section.name.trim())
      throw new Error("Invalid Codex section name");
    const threadIds: string[] = [];
    for (const item of strings(section.itemKeys)) {
      const id = item.startsWith("codex:thread:local:")
        ? item.slice("codex:thread:local:".length)
        : null;
      const candidates = id ? matches.get(id) : undefined;
      if (!candidates || candidates.size !== 1) {
        counts.unmatchedCount++;
        if (candidates && candidates.size > 1) counts.ambiguousCount++;
        continue;
      }
      const threadId = [...candidates][0]!;
      if (assigned.has(threadId)) {
        counts.duplicateCount++;
        continue;
      }
      assigned.add(threadId);
      threadIds.push(threadId);
      counts.matchedCount++;
    }
    const appearance =
      section.appearance !== null && typeof section.appearance === "object"
        ? object(section.appearance)
        : {};
    return {
      id: `codex-section:${section.id as string}`,
      name: section.name.trim(),
      threadIds,
      collapsed: collapsed.has(section.id as string),
      ...(typeof appearance.color === "string" || typeof appearance.icon === "string"
        ? {
            appearance: {
              ...(typeof appearance.color === "string" && appearance.color.trim()
                ? { color: appearance.color }
                : {}),
              ...(typeof appearance.icon === "string" && appearance.icon.trim()
                ? { icon: appearance.icon }
                : {}),
            },
          }
        : {}),
    };
  });
  return { sections: imported, codexImport: counts };
}

/** Moving is one metadata change, independent of a thread's project and lifecycle. */
export function moveThreadToSidebarSection(
  state: SidebarSections,
  threadId: string,
  sectionId: string | null,
): SidebarSections {
  if (sectionId !== null && !state.sections.some((section) => section.id === sectionId)) {
    throw new Error("Section no longer exists");
  }
  return {
    ...state,
    sections: state.sections.map((section) => ({
      ...section,
      threadIds: [
        ...section.threadIds.filter((id) => id !== threadId),
        ...(section.id === sectionId ? [threadId] : []),
      ],
    })),
  };
}
