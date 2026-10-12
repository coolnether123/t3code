import { useState, type ReactNode } from "react";
import type { EnvironmentId, SidebarSection, SidebarSections } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { randomUUID } from "../lib/utils";

export function SidebarClientSections(props: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  renderThread: (thread: EnvironmentThreadShell) => ReactNode;
  onLayoutChange: () => void;
}) {
  const state = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.sidebarSections,
  ) ?? { sections: [] };
  const update = useUpdateEnvironmentSettings(props.environmentId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const persist = (sections: SidebarSections["sections"]) => {
    props.onLayoutChange();
    update({ sidebarSections: { ...state, sections } });
  };
  const edit = (section: SidebarSection | null) => {
    setEditingId(section?.id ?? "new");
    setName(section?.name ?? "");
  };
  const commit = () => {
    if (!name.trim()) return;
    if (editingId === "new") {
      persist([
        ...state.sections,
        { id: randomUUID(), name: name.trim(), collapsed: false, threadIds: [] },
      ]);
    } else {
      persist(
        state.sections.map((section) =>
          section.id === editingId ? { ...section, name: name.trim() } : section,
        ),
      );
    }
    setEditingId(null);
  };
  const reorder = (id: string, targetIndex: number) => {
    const section = state.sections.find((entry) => entry.id === id);
    if (!section) return;
    const sections = state.sections.filter((entry) => entry.id !== id);
    sections.splice(Math.max(0, Math.min(targetIndex, sections.length)), 0, section);
    persist(sections);
  };
  const menu = async (
    section: SidebarSection,
    index: number,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const action = await api.contextMenu.show(
      [
        { id: "rename", label: "Rename section" },
        { id: "up", label: "Move section up", disabled: index === 0 },
        { id: "down", label: "Move section down", disabled: index === state.sections.length - 1 },
        { id: "delete", label: "Delete section", destructive: true },
      ],
      position,
    );
    if (action === "rename") edit(section);
    if (action === "up") reorder(section.id, index - 1);
    if (action === "down") reorder(section.id, index + 1);
    if (
      action === "delete" &&
      (await api.dialogs.confirm(
        "Delete this section? Its chats will stay in T3 and return to the sidebar.",
        { variant: "destructive" },
      ))
    ) {
      persist(state.sections.filter((entry) => entry.id !== section.id));
    }
  };
  const nameInput = (
    <form
      className="flex min-w-0 gap-1 px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        autoFocus
        aria-label="Section name"
        placeholder="Section name"
        value={name}
        maxLength={160}
        className="min-w-0 flex-1 rounded border bg-sidebar px-2 py-1 text-sm"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditingId(null);
        }}
      />
      <button type="submit" className="px-1 text-xs" disabled={!name.trim()}>
        Save
      </button>
      <button
        type="button"
        aria-label="Cancel section name"
        className="px-1 text-xs"
        onClick={() => setEditingId(null)}
      >
        Cancel
      </button>
    </form>
  );
  const byId = new Map(props.threads.map((thread) => [thread.id as string, thread]));
  return (
    <li className="list-none" data-sidebar-sections={props.environmentId}>
      <ul aria-label={`Sections on ${props.environmentLabel}`} className="flex flex-col gap-1">
        {state.sections.map((section, index) => {
          const threads = section.threadIds.flatMap((id) => {
            const thread = byId.get(id);
            return thread && thread.archivedAt === null ? [thread] : [];
          });
          const color = /^#[0-9a-f]{3,8}$/i.test(section.appearance?.color ?? "")
            ? section.appearance?.color
            : undefined;
          return (
            <li
              key={section.id}
              className="list-none"
              data-section-id={section.id}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("application/x-t3-section"))
                  event.preventDefault();
              }}
              onDrop={(event) => {
                const [environmentId, id] = event.dataTransfer
                  .getData("application/x-t3-section")
                  .split("\n");
                if (environmentId !== props.environmentId || !id) return;
                event.preventDefault();
                reorder(id, index);
              }}
            >
              {editingId === section.id ? (
                nameInput
              ) : (
                <div className="group/section flex items-center gap-1 rounded px-1 py-1 text-xs font-medium text-sidebar-muted-foreground">
                  <button
                    type="button"
                    draggable
                    aria-expanded={!section.collapsed}
                    aria-label={`${section.collapsed ? "Expand" : "Collapse"} section ${section.name}`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2"
                    onDragStart={(event) =>
                      event.dataTransfer.setData(
                        "application/x-t3-section",
                        `${props.environmentId}\n${section.id}`,
                      )
                    }
                    onClick={() =>
                      persist(
                        state.sections.map((entry) =>
                          entry.id === section.id
                            ? { ...entry, collapsed: !entry.collapsed }
                            : entry,
                        ),
                      )
                    }
                  >
                    {section.collapsed ? (
                      <ChevronRightIcon className="size-3" />
                    ) : (
                      <ChevronDownIcon className="size-3" />
                    )}
                    {section.appearance?.icon && section.appearance.icon.length <= 8 ? (
                      <span aria-hidden>{section.appearance.icon}</span>
                    ) : (
                      <FolderIcon className="size-3.5 shrink-0" style={{ color }} />
                    )}
                    <span className="truncate" style={{ color }}>
                      {section.name}
                    </span>
                    <span className="ms-auto text-[10px] tabular-nums">{threads.length}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Section menu for ${section.name}`}
                    className="rounded p-1 hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2"
                    onClick={(event) => {
                      void menu(section, index, { x: event.clientX, y: event.clientY });
                    }}
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </button>
                </div>
              )}
              {!section.collapsed ? (
                <ul aria-label={`Chats in ${section.name}`} className="flex flex-col gap-px ps-3">
                  {threads.map(props.renderThread)}
                  {threads.length === 0 ? (
                    <li className="px-2 py-1 text-xs text-sidebar-muted-foreground">
                      No chats in this section
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {editingId === "new" ? (
        nameInput
      ) : (
        <button
          type="button"
          className="flex items-center gap-2 rounded px-2 py-2 text-xs text-sidebar-muted-foreground hover:bg-sidebar-accent"
          aria-label={`New section on ${props.environmentLabel}`}
          onClick={() => edit(null)}
        >
          <PlusIcon className="size-3.5" />
          New section
        </button>
      )}
    </li>
  );
}
