import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProjectId,
  type ProjectSection,
  type ServerConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useProject, useQuietThreadShells, useServerConfigs } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { makeThreadFixture } from "../../test-fixtures";
import { SectionPanel } from "./SectionPanel";
import "../../index.css";

vi.mock("../../state/entities", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock("../../state/use-orchestration-command", { spy: true });

const environmentId = EnvironmentId.make("environment-test");
const projectId = ProjectId.make("project-test");
const projectRef = scopeProjectRef(environmentId, projectId);

function setup({ authorized = true, supported = true } = {}) {
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
      {
        id: "client",
        name: "Client",
        collapsed: false,
        rules: "Check the company",
        scope: { clientName: "Client A", qboRealm: "12345" },
      },
      {
        id: "payables",
        name: "Payables",
        parentSectionId: "client",
        collapsed: false,
        rules: "Check invoices",
        prompt: "Review bills",
      },
    ],
    sectionHistory: [],
  };
  vi.mocked(useProject).mockReturnValue(project);
  vi.mocked(useQuietThreadShells).mockReturnValue([
    makeThreadFixture({ environmentId, projectId, title: "Invoice review", sectionId: "payables" }),
  ]);
  vi.mocked(useEnvironmentScope).mockReturnValue(authorized);
  const config = {
    environment: { capabilities: { projectSections: true, projectSectionRules: supported } },
  } as ServerConfig;
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([[environmentId, config as EnvironmentServerConfig]]),
  );
  const update = vi.fn(
    async (_command: {
      environmentId: EnvironmentId;
      input?: { projectId: ProjectId; sections?: readonly ProjectSection[] };
    }) => AsyncResult.success(undefined),
  );
  vi.mocked(useOrchestrationCommand).mockReturnValue(update);
  return { project, update };
}

describe("section panel", () => {
  it("saves rules, prompt and scope to the destination, then reads saved rules and history from the next snapshot at phone width", async () => {
    const { project, update } = setup();
    await page.viewport(390, 844);
    await using screen = await render(
      <SectionPanel projectRef={projectRef} sectionId="payables" />,
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Section rules", exact: true }),
      "Match the invoice total",
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Section prompt", exact: true }),
      "Review the open invoices",
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Mailbox", exact: true }),
      " ap@example.test ",
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Standing decisions", exact: true }),
      "Keep originals\n\nCheck duplicates",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    const command = update.mock.calls[0]?.[0] as unknown as {
      environmentId: string;
      input: { projectId: string; sections: readonly ProjectSection[] };
    };
    expect(command.environmentId).toBe(environmentId);
    expect(command.input.projectId).toBe(projectId);
    expect(command.input).toHaveProperty("expectedSections", project.sections);
    expect(command.input).not.toHaveProperty("sectionHistory");
    expect(command.input.sections[0]).toEqual(project.sections?.[0]);
    expect(command.input.sections[1]).toMatchObject({
      parentSectionId: "client",
      rules: "Match the invoice total",
      prompt: "Review the open invoices",
      scope: {
        mailbox: "ap@example.test",
        standingDecisions: ["Keep originals", "Check duplicates"],
      },
    });
    vi.mocked(useProject).mockReturnValue({
      ...project,
      sections: command.input.sections,
      sectionHistory: [
        {
          id: "edit-1",
          sectionId: "payables",
          actor: "Christine",
          createdAt: "2026-01-02T00:00:00.000Z",
          changes: [{ field: "rules", before: "Check invoices", after: "Match the invoice total" }],
        },
      ],
    });
    await screen.rerender(<SectionPanel projectRef={projectRef} sectionId="payables" />);
    await expect
      .element(screen.getByRole("textbox", { name: "Section rules", exact: true }))
      .toHaveValue("Match the invoice total");
    expect(screen.container.querySelector("pre")?.textContent).toContain("Check the company");
    expect(screen.container.querySelector("pre")?.textContent).toContain("Match the invoice total");
    expect(screen.container.querySelector("pre")?.textContent).toContain("No payments");
    await expect.element(screen.getByRole("button", { name: "Invoice review" })).toBeVisible();
    expect(screen.container.scrollWidth).toBeLessThanOrEqual(390);
  });

  it("keeps a failed draft and refuses to overwrite an edit that arrives from another device", async () => {
    const { project } = setup();
    const update = vi.fn(async () => AsyncResult.failure(Cause.fail(new Error("not saved"))));
    vi.mocked(useOrchestrationCommand).mockReturnValue(update);
    await using screen = await render(
      <SectionPanel projectRef={projectRef} sectionId="payables" />,
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Section rules", exact: true }),
      "My draft",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await expect
      .element(screen.getByRole("textbox", { name: "Section rules", exact: true }))
      .toHaveValue("My draft");
    vi.mocked(useProject).mockReturnValue({
      ...project,
      sections: project.sections?.map((section) =>
        section.id === "payables" ? { ...section, rules: "Saved on other device" } : section,
      ),
    });
    await screen.rerender(<SectionPanel projectRef={projectRef} sectionId="payables" />);
    await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(update).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Reload saved version" }));
    await expect
      .element(screen.getByRole("textbox", { name: "Section rules", exact: true }))
      .toHaveValue("Saved on other device");
  });

  it.each([
    { authorized: false, supported: true },
    { authorized: true, supported: false },
  ])("does not offer edits without permission and new-server support: %j", async (options) => {
    const { update } = setup(options);
    await using screen = await render(
      <SectionPanel projectRef={projectRef} sectionId="payables" />,
    );
    await expect
      .element(screen.getByRole("textbox", { name: "Section rules", exact: true }))
      .toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });
});
