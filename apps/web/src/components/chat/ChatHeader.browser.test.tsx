import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import "../../index.css";

const persisted = vi.hoisted(() => ({ title: "" }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));

import { render } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

it("opens the chat's nested section as a right-panel tab from its chip at phone width", async () => {
  using stack = new DisposableStack();
  const previous = useRightPanelStore.getState();
  stack.defer(() => useRightPanelStore.setState(previous));
  const environmentId = EnvironmentId.make("section-environment");
  const threadId = ThreadId.make("section-thread");
  await page.viewport(390, 844);
  await using screen = await render(
    <ChatHeader
      activeThreadEnvironmentId={environmentId}
      activeThreadId={threadId}
      activeThreadTitle="Invoice review"
      activeThreadSectionId="payables"
      isServerThread
      activeProject={{
        id: ProjectId.make("section-project"),
        environmentId,
        title: "Client work",
        workspaceRoot: "/workroom",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sections: [
          { id: "client", name: "Client A", collapsed: false },
          {
            id: "payables",
            name: "Payables and invoice review",
            parentSectionId: "client",
            collapsed: false,
          },
        ],
      }}
      parentThreadLink={null}
      onOpenThread={() => {}}
      rightPanelOpen={false}
      onNewThreadInProject={() => {}}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open Payables and invoice review section" }),
  );
  expect(
    selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      scopeThreadRef(environmentId, threadId),
    ),
  ).toMatchObject({
    kind: "section",
    sectionId: "payables",
    project: { environmentId, projectId: "section-project" },
  });
  expect(screen.container.scrollWidth).toBeLessThanOrEqual(390);
});

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);
