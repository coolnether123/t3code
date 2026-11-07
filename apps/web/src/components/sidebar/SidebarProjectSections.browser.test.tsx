import { DndContext } from "@dnd-kit/core";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarProjectSections } from "./SidebarProjectSections";
import type { ProjectSection } from "./projectSections.logic";

function Harness({
  record,
}: {
  readonly record: (
    sections: readonly ProjectSection[],
    unsortedSectionCollapsed?: boolean,
  ) => void;
}) {
  const [project, setProject] = useState<EnvironmentProject>({
    id: ProjectId.make("project-test"),
    environmentId: EnvironmentId.make("environment-test"),
    title: "Workroom",
    workspaceRoot: "/workroom",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sections: [],
    unsortedSectionCollapsed: false,
  });
  const thread = makeThreadFixture({ title: "Client work", sectionId: "deleted-section" });
  const update = async (
    _project: ScopedProjectRef,
    sections: readonly ProjectSection[],
    unsortedSectionCollapsed = project.unsortedSectionCollapsed,
  ) => {
    record(sections, unsortedSectionCollapsed);
    setProject({ ...project, sections, unsortedSectionCollapsed });
    return true;
  };
  return (
    <DndContext>
      <ul>
        <SidebarProjectSections
          projects={[project]}
          threads={[thread]}
          canUpdate={() => true}
          onUpdate={update}
          renderThread={(thread) => <li key={thread.id}>{thread.title}</li>}
        />
      </ul>
    </DndContext>
  );
}

describe("project section management", () => {
  it("creates from an empty layout, renames, reorders, collapses and deletes without losing chats", async () => {
    const record = vi.fn();
    await using screen = await render(<Harness record={record} />);
    const create = async (name: string) => {
      await userEvent.click(screen.getByRole("button", { name: "Create section in Workroom" }));
      await userEvent.type(page.getByRole("textbox", { name: "Section name" }), name);
      await userEvent.keyboard("{Enter}");
      await expect
        .element(screen.getByRole("button", { name: `${name} section`, exact: true }))
        .toBeVisible();
    };
    await create("Client A");
    await create("Client B");
    await userEvent.click(screen.getByRole("button", { name: "Manage Client B section" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Move section up" }));
    expect(record.mock.lastCall?.[0].map((section: ProjectSection) => section.name)).toEqual([
      "Client B",
      "Client A",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Manage Client B section" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Rename section" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Section name" }), "Client C");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("button", { name: "Client C section", exact: true }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Client A section", exact: true }));
    expect(
      record.mock.lastCall?.[0].find((section: ProjectSection) => section.name === "Client A")
        ?.collapsed,
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Unsorted section", exact: true }));
    expect(record.mock.lastCall?.[1]).toBe(true);
    await expect.element(screen.getByText("Client work", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unsorted section", exact: true }));
    await expect.element(screen.getByText("Client work", { exact: true })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Manage Client C section" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete section" }));
    await expect
      .element(page.getByText("Chats in Client C will move to Unsorted. No chats will be deleted."))
      .toBeVisible();
    page.getByRole("button", { name: "Delete section", exact: true }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("button", { name: "Client C section", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("Client work", { exact: true })).toBeVisible();
    expect(record.mock.lastCall?.[0].map((section: ProjectSection) => section.name)).toEqual([
      "Client A",
    ]);
  });
});
