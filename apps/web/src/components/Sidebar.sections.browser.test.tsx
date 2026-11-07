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
    for (const other of otherThreads) {
      expect(
        screen.container.querySelector(
          `[data-thread-item="${scopedThreadKey(scopeThreadRef(other.environmentId, other.id))}"]`,
        ),
      ).not.toBeNull();
    }
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
