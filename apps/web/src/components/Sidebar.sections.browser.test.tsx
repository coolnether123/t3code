import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { makeThreadFixture } from "../test-fixtures";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";
import "../index.css";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: readonly { environmentId: EnvironmentId }[]) =>
    new Set(environments.map((environment) => environment.environmentId)),
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

describe("sidebar project sections", () => {
  it("reads saved child expansion, nests across filing sections, and opens descendants", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: false,
      legacySidebarEnabled: false,
    });
    const environmentId = EnvironmentId.make("environment-test");
    const projectId = ProjectId.make("project-test");
    const project: EnvironmentProject = {
      id: projectId,
      environmentId,
      title: "Workroom",
      workspaceRoot: "/workroom",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sections: [
        { id: "client-a", name: "Client A", collapsed: false },
        { id: "client-b", name: "Client B", collapsed: false },
      ],
    };
    const parent = makeThreadFixture({
      id: ThreadId.make("parent"),
      title: "Parent work",
      sectionId: "client-a",
    });
    const child = makeThreadFixture({
      id: ThreadId.make("child"),
      title: "Child work",
      sectionId: "client-b",
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: "child",
      },
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const grandchild = makeThreadFixture({
      id: ThreadId.make("grandchild"),
      title: "Grandchild work",
      sectionId: "client-b",
      hasPendingUserInput: true,
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: child.id,
        relationshipToParent: "subagent",
      },
    });
    const promoted = makeThreadFixture({
      id: ThreadId.make("client-orphan"),
      title: "Visible client work",
      sectionId: "client-b",
      lineage: {
        rootThreadId: ThreadId.make("hidden-infrastructure"),
        parentThreadId: ThreadId.make("hidden-infrastructure"),
        relationshipToParent: "child",
      },
    });
    let threads = [parent, child, grandchild, promoted];
    vi.mocked(useProjects).mockReturnValue([project]);
    vi.mocked(useQuietThreadShells).mockImplementation(() => threads);
    const config = { environment: { capabilities: { projectSections: true } } } as ServerConfig;
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([[environmentId, config as EnvironmentServerConfig]]),
    );
    const update = vi.fn(
      async (value: {
        environmentId: EnvironmentId;
        input?: { threadId?: ThreadId; childrenExpanded?: boolean };
      }) => {
        const childrenExpanded = value.input?.childrenExpanded;
        if (childrenExpanded !== undefined) {
          threads = threads.map((thread) =>
            thread.id === value.input?.threadId ? { ...thread, childrenExpanded } : thread,
          );
        }
        return AsyncResult.success(undefined);
      },
    );
    vi.mocked(useOrchestrationCommand).mockReturnValue(update);
    const ui = () => (
      <SidebarProvider>
        <aside className="flex h-screen w-72 flex-col">
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </aside>
      </SidebarProvider>
    );
    await using screen = await render(ui());
    const row = (id: ThreadId) =>
      screen.container.querySelector(`[data-thread-item="${environmentId}:${id}"]`);
    expect(row(child.id)).toBeNull();
    expect(
      row(promoted.id)?.closest("[data-project-section]")?.getAttribute("data-project-section"),
    ).toBe("client-b");
    await screen.getByRole("button", { name: "Expand children of Parent work, 1 child" }).click();
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ input: { threadId: parent.id, childrenExpanded: true } }),
      ),
    );
    await screen.rerender(ui());
    expect(
      row(child.id)?.closest("[data-project-section]")?.getAttribute("data-project-section"),
    ).toBe("client-a");
    expect(row(child.id)?.querySelector("[data-child-status]")?.textContent).toMatch(/Working\d/);
    expect(row(grandchild.id)).toBeNull();
    await screen.getByRole("button", { name: "Expand children of Child work, 1 child" }).click();
    await screen.rerender(ui());
    expect(
      row(grandchild.id)?.closest("[data-project-section]")?.getAttribute("data-project-section"),
    ).toBe("client-a");
    expect(row(grandchild.id)?.querySelector("[data-child-status]")?.textContent).toContain(
      "Waiting on you",
    );
    await userEvent.click(row(grandchild.id)!.querySelector<HTMLElement>("[data-sidebar-row]")!);
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/environment-test/grandchild"),
    );
    await screen.getByRole("button", { name: "Collapse children of Parent work, 1 child" }).click();
    await screen.rerender(ui());
    expect(row(child.id)).toBeNull();
    expect(screen.container.textContent).not.toContain("hidden-infrastructure");
  });

  it("moves a chat by dragging and by its menu, then reads the assignments back from a fresh snapshot", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: false,
      legacySidebarEnabled: false,
    });
    const environmentId = EnvironmentId.make("environment-test");
    const projectId = ProjectId.make("project-test");
    const project: EnvironmentProject = {
      id: projectId,
      environmentId,
      title: "Workroom",
      workspaceRoot: "/workroom",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sections: [
        { id: "client-a", name: "Client A", collapsed: false },
        { id: "client-b", name: "Client B", collapsed: false },
        { id: "payables", name: "Payables", parentSectionId: "client-b", collapsed: false },
      ],
    };
    let thread = makeThreadFixture({
      environmentId,
      projectId,
      title: "Client work",
      sectionId: "client-a",
    });
    const otherThreads = [
      makeThreadFixture({
        id: ThreadId.make("pinned"),
        title: "Pinned work",
        pinnedAt: "2026-01-01T00:00:00.000Z",
      }),
      makeThreadFixture({
        id: ThreadId.make("settled"),
        title: "Settled work",
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
      makeThreadFixture({
        id: ThreadId.make("snoozed"),
        title: "Snoozed work",
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      }),
      makeThreadFixture({
        id: ThreadId.make("working"),
        title: "Running work",
        runtime: {
          status: "running",
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ];
    vi.mocked(useProjects).mockReturnValue([project]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread, ...otherThreads]);
    const config = { environment: { capabilities: { projectSections: true } } } as ServerConfig;
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([[environmentId, config as EnvironmentServerConfig]]),
    );
    const move = vi.fn(
      async (value: {
        environmentId: EnvironmentId;
        input?: { sectionId?: string | null; sectionAssignment?: string };
      }) => {
        if (value.input?.sectionId !== undefined) {
          thread = { ...thread, sectionId: value.input.sectionId, sectionManualOverride: true };
        }
        return AsyncResult.success(undefined);
      },
    );
    vi.mocked(useOrchestrationCommand).mockReturnValue(move);
    const ui = () => (
      <SidebarProvider>
        <aside className="flex h-screen w-72 flex-col">
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </aside>
      </SidebarProvider>
    );
    await page.viewport(1024, 900);
    await using screen = await render(ui());
    expect(
      screen.getByRole("button", { name: "New chat in Client A", exact: true }).element(),
    ).not.toBeNull();
    for (const other of otherThreads) {
      const row = screen.container.querySelector(
        `[data-thread-item="${scopedThreadKey(scopeThreadRef(other.environmentId, other.id))}"]`,
      );
      if (other.settledOverride === "settled") expect(row).toBeNull();
      else expect(row).not.toBeNull();
    }
    await userEvent.click(screen.getByRole("button", { name: "Settled (1)", exact: true }));
    expect(
      screen.container.querySelector(
        `[data-thread-item="${scopedThreadKey(scopeThreadRef(otherThreads[1]!.environmentId, otherThreads[1]!.id))}"]`,
      ),
    ).not.toBeNull();
    const source = screen.container.querySelector<HTMLElement>(
      `[data-thread-item="${scopedThreadKey(scopeThreadRef(environmentId, thread.id))}"] [data-sidebar-row]`,
    )!;
    expect(source).not.toBeNull();
    const target = screen.getByRole("button", { name: "Payables section", exact: true }).element();
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const pointer = {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
    };
    await act(() =>
      source.dispatchEvent(
        new PointerEvent("pointerdown", {
          ...pointer,
          clientX: sourceRect.left + 30,
          clientY: sourceRect.top + 10,
        }),
      ),
    );
    await act(() =>
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          ...pointer,
          clientX: sourceRect.left + 30,
          clientY: sourceRect.top + 20,
        }),
      ),
    );
    await act(() =>
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          ...pointer,
          clientX: targetRect.left + 30,
          clientY: targetRect.top + 10,
        }),
      ),
    );
    await act(() =>
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          ...pointer,
          buttons: 0,
          clientX: targetRect.left + 30,
          clientY: targetRect.top + 10,
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(move).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          input: expect.objectContaining({ sectionId: "payables", sectionAssignment: "manual" }),
        }),
      ),
    );
    vi.mocked(useQuietThreadShells).mockReturnValue([thread, ...otherThreads]);
    await screen.rerender(ui());
    expect(
      screen.container.querySelector('[data-project-section="payables"] [data-thread-item]'),
    ).not.toBeNull();

    const row = screen.container.querySelector<HTMLElement>(
      '[data-project-section="payables"] [data-thread-item] [data-sidebar-row]',
    )!;
    await userEvent.click(row, { button: "right" });
    await userEvent.hover(page.getByRole("menuitem", { name: "Move to section", exact: true }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Unsorted", exact: true }));
    await vi.waitFor(() =>
      expect(move).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ sectionId: null, sectionAssignment: "manual" }),
        }),
      ),
    );
    vi.mocked(useQuietThreadShells).mockReturnValue([thread, ...otherThreads]);
    await screen.rerender(ui());
    expect(
      screen.container.querySelector('[data-project-section="unsorted"] [data-thread-item]'),
    ).not.toBeNull();
    expect(thread.sectionManualOverride).toBe(true);
  });
});
