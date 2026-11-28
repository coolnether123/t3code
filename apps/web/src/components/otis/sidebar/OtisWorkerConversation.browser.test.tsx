import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import "~/index.css";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  answerRpc,
} from "../../../../test/fakeEnvironment";
import { render } from "../../../../test/render";
vi.mock("../../../../../../packages/client-runtime/src/connection/driver.ts", async (original) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    original<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

import type { OtisFleetEvent, OtisNode, OtisTailInput, OtisTreeRead } from "@t3tools/contracts";
import type { OtisAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import fixture from "../../../../../../apps/server/src/otis/fixtures/tree-stream.ndjson?raw";
import { OtisTreeBatch } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

it("opens a managed worker directly and replies in its live transcript", async () => {
  await page.viewport(1280, 844);
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OtisTreeBatch));
  const [roots, children] = fixture.split("\n");
  const nodes = [...decode(roots!).nodes, ...decode(children!).nodes];
  const parent = nodes.find((node) => node.id === "lane:otis-1")!;
  const activeParent: OtisNode = {
    ...parent,
    title: "Release verification",
    state: "running",
    waiting: 1,
    model: "gpt-6.2-sol",
    modelEvidence: "requested",
    costSource: "api-equivalent-t3",
    costUsd: 1234.56,
    tokens: { in: 1200000, out: 0, cached: 0, total: 1200000 },
    sub: { ...parent.sub, failedUnseen: 4, failed: 9, done: 103, running: 12 },
  };
  const b = nodes.find((node) => node.kind === "run")!;
  const worker: OtisNode = {
    ...b,
    title: "Otis: fixes and releases",
    chat: { host: "otis", threadId: "native-worker-thread" },
    parent: "lane:otis-1",
    state: "running",
    settled: false,
    can: ["message"],
    tailSeq: 10,
  };
  const unknownParent: OtisNode = {
    ...activeParent,
    id: "lane:synthetic-unknown",
    lane: "synthetic-unknown",
    title: "Documentation and accessibility regression verification",
    model: "No model assigned",
    modelEvidence: null,
    costSource: "unpriced",
    costUsd: null,
    tokens: null,
    state: "idle",
    waiting: 0,
    chat: null,
    sub: { nodes: 1, running: 12, waiting: 0, failedUnseen: 0, failed: 0, tokens: 0 },
  };
  const unknownChild = {
    ...worker,
    id: "run:synthetic-child",
    title: "Synthetic accessibility worker",
    lane: unknownParent.lane,
    parent: unknownParent.id,
    chat: null,
  };
  const frames = new TransformStream<OtisFleetEvent, OtisFleetEvent>();
  const writer = frames.writable.getWriter();
  const pastWorker: OtisNode = {
    ...worker,
    id: "finished-worker",
    title: "Otis: router unfreeze",
    state: "done",
    settled: true,
    can: [],
  };
  using _fleet = answerRpc("otis.subscribe", ({ read }: { read?: OtisTreeRead }) =>
    read
      ? Stream.make({ type: "read" as const, result: { nodes: [pastWorker], next: null } })
      : Stream.fromReadableStream({ evaluate: () => frames.readable, onError: String }),
  );
  const act = vi.fn((_input: OtisAction) => Effect.succeed({ accepted: true }));
  using _act = answerRpc("otis.act", act);
  using _tail = answerRpc("otis.nodeTail", ({ nodeId, after }: OtisTailInput) =>
    Effect.succeed({
      nodeId,
      items: [
        {
          seq: after === undefined ? 10 : 20,
          at: "2026-11-23T00:00:00Z",
          role: "assistant" as const,
          from: "self" as const,
          text: after === undefined ? "I have the release." : "I checked the receipt.",
          cut: false,
          tool: null,
        },
      ],
      prev: null,
      next: null,
      end: true,
    }),
  );
  const threads = [threadWithHistory("Release notes", 1)];
  using _environment = installFakeEnvironment(threads);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    panelAnimationDurationMs: 0,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await writer.write({
    type: "snapshot",
    seq: 1,
    nodes: [activeParent, worker, unknownParent, unknownChild],
    waiting: null,
    load: null,
  });
  const workers = page.getByRole("region", { name: "Otis workers" });
  const toggle = workers.getByRole("button", { name: "Otis workers" });
  await expect.element(toggle).toBeVisible();
  expect(toggle.element()).toHaveAttribute("aria-expanded", "false");
  expect(workers.getByRole("button", { name: worker.title }).query()).toBeNull();
  const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
  sidebar
    .closest<HTMLElement>('[data-slot="sidebar-wrapper"]')!
    .style.setProperty("--sidebar-width", "230px");
  expect(sidebar.getBoundingClientRect().width).toBe(230);
  const failureChip = page.getByText("4 failed", { exact: true });
  await expect.element(failureChip).toBeVisible();
  const row = failureChip.element().closest<HTMLElement>("[data-fleet-row]")!;
  const unknownTitle = page.getByText(unknownParent.title, { exact: true });
  await expect.element(unknownTitle).toBeVisible();
  await document.fonts.ready;
  const ordinaryTitle = page
    .getByText(activeParent.title, { exact: true })
    .element() as HTMLElement;
  expect(ordinaryTitle.scrollWidth).toBeLessThanOrEqual(ordinaryTitle.clientWidth);
  const unknownRow = unknownTitle.element().closest<HTMLElement>("[data-fleet-row]")!;
  for (const parentRow of [row, unknownRow]) {
    expect(parentRow.querySelector(":scope > button[aria-expanded]")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const meta = parentRow.querySelector<HTMLElement>("[data-otis-parent-meta]")!;
    for (const field of meta.children as HTMLCollectionOf<HTMLElement>) {
      expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth);
      expect(field.getBoundingClientRect().right).toBeLessThanOrEqual(
        meta.getBoundingClientRect().right,
      );
    }
    const info = parentRow.querySelector<HTMLElement>('[data-slot="popover-trigger"]')!;
    expect(info.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      meta.getBoundingClientRect().top,
    );
  }
  const needsYou = page.getByText("1 needs you", { exact: true }).element();
  expect(failureChip.element().getBoundingClientRect().top).toBe(
    needsYou.getBoundingClientRect().top,
  );
  for (const chip of [failureChip.element(), needsYou]) {
    const range = document.createRange();
    range.selectNodeContents(chip);
    expect(range.getClientRects()).toHaveLength(1);
  }
  await expect.element(page.getByText("≈$1.2K", { exact: true })).toBeVisible();
  await expect.element(page.getByText("No model", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Unknown", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Parent turn running" })).toBeVisible();
  await expect.element(page.getByText("103 done", { exact: true })).not.toBeInTheDocument();
  const expand = page.getByRole("button", { name: "Expand Release verification" });
  expect(expand.element()).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Details for Release verification" }).click();
  await expect.element(page.getByText("103 done", { exact: true })).toBeVisible();
  await expect.element(page.getByText("1,200,000 tokens today")).toBeVisible();
  const popup = page.getByRole("dialog").filter({ hasText: "103 done" });
  await expect.element(popup.getByText("4 failures to dismiss")).toBeVisible();
  await expect.element(popup.getByText("API-equivalent estimate today: $1,234.56")).toBeVisible();
  await expect.element(popup.getByText(/gpt-6\.2-sol/)).toBeVisible();
  await writer.write({
    type: "delta",
    seq: 2,
    nodes: [
      { ...activeParent, rev: activeParent.rev + 1, sub: { ...activeParent.sub, failedUnseen: 0 } },
    ],
  });
  await expect.element(failureChip).not.toBeInTheDocument();
  await expect.element(page.getByText("9 failed since the parent started")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(workers.getByRole("button", { name: pastWorker.title })).toBeVisible();
  await workers.getByRole("button", { name: worker.title }).click();
  await expect.element(page.getByText("I have the release.")).toBeVisible();
  await page.getByRole("textbox", { name: "Message this worker" }).fill("Check the receipt.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(page.getByText("Message accepted.")).toBeVisible();
  expect(act).toHaveBeenCalledExactlyOnceWith({
    type: "message",
    nodeId: worker.id,
    text: "Check the receipt.",
    requestId: expect.any(String),
  });
  await writer.write({
    type: "delta",
    seq: 3,
    nodes: [{ ...worker, tailSeq: 20, rev: worker.rev + 1 }],
  });
  await expect.element(page.getByText("I checked the receipt.")).toBeVisible();
  await workers.getByRole("button", { name: pastWorker.title }).click();
  await expect.element(page.getByRole("heading", { name: pastWorker.title })).toBeVisible();
  await expect.element(page.getByText("I have the release.")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Message this worker" }))
    .not.toBeInTheDocument();
});
