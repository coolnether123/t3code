import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId, type SidebarSections } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { SidebarClientSections } from "./SidebarClientSections";

const fixture = vi.hoisted(() => ({ state: { sections: [] } as SidebarSections }));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentSettings: () => fixture.state,
  useUpdateEnvironmentSettings: () => vi.fn(),
}));
vi.mock("../localApi", () => ({ readLocalApi: () => null }));
const environmentId = EnvironmentId.make("synthetic-mac");
const thread = (id: string, projectId: string) =>
  ({
    id: ThreadId.make(id),
    environmentId,
    projectId,
    archivedAt: null,
  }) as EnvironmentThreadShell;
const render = (threads: EnvironmentThreadShell[]) =>
  renderToStaticMarkup(
    <SidebarClientSections
      environmentId={environmentId}
      environmentLabel="Synthetic Mac"
      threads={threads}
      onLayoutChange={() => {}}
      renderThread={(thread) => <li key={thread.id}>{thread.id}</li>}
    />,
  );
describe("client section rendering", () => {
  it("shows chats from different projects in one section and keeps section order", () => {
    fixture.state = {
      sections: [
        { id: "b", name: "Client B", collapsed: false, threadIds: ["one", "two"] },
        { id: "a", name: "Client A", collapsed: false, threadIds: [] },
      ],
    };
    const html = render([thread("one", "project-a"), thread("two", "project-b")]);
    expect(html.indexOf("Client B")).toBeLessThan(html.indexOf("Client A"));
    expect(html).toContain("Chats in Client B");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
    expect(html).toContain("No chats in this section");
  });
  it("keeps the collapsed section header and hides its chat rows", () => {
    fixture.state = {
      sections: [{ id: "a", name: "Client A", collapsed: true, threadIds: ["one"] }],
    };
    const html = render([thread("one", "project-a")]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Expand section Client A");
    expect(html).not.toContain("<li>one</li>");
  });
});
