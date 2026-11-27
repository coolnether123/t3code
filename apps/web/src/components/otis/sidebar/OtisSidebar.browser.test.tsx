import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
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
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import fixture from "../../../../../../apps/server/src/otis/fixtures/tree-stream.ndjson?raw";
import { OtisTreeBatch } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

function exampleTree() {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OtisTreeBatch));
  const lanes = decode(fixture.split("\n")[0]!).nodes;
  const base = lanes[0]!;
  const child = decode(fixture.split("\n")[1]!).nodes.find((n) => n.kind === "run")!;
  const tokens = (total: number) => ({ in: total, out: 0, cached: 0, total });
  const models = ["Astra 6.2", "Opus 5.5", "Sol 6.2", "Opus 5.5", "Sol 6.2"];
  const roots = lanes.map((node, i) => ({
    ...node,
    model: models[i]!,
    tokens: tokens([1200000, 310000, 88000, 540000, 12000][i]!),
  }));
  const parent: OtisNode = {
    ...roots[0]!,
    chat: { host: "otis", threadId: "fixture-parent" },
    sub: { ...base.sub, nodes: 7, running: 2, failed: 46, done: 312 },
    lastActivityAt: "2026-11-23T00:00:00Z",
  };
  const a: OtisNode = {
    ...child,
    id: "a",
    title: "Verify the sidebar tree stream",
    model: "Astra 6.2",
    tokens: tokens(412000),
    chat: { host: "t3", environmentId: ENVIRONMENT_ID, threadId: "November maintenance schedule" },
  };
  const b: OtisNode = {
    ...a,
    id: "b",
    title: "Check the November release queue",
    model: "Sol 6.2",
    costSource: "api-equivalent-t3",
    costUsd: 3.1,
    tokens: tokens(96000),
    chat: { host: "otis" },
  };
  const c: OtisNode = { ...b, id: "c", title: "Update the phone pairing notes", state: "idle" };
  const d: OtisNode = {
    ...b,
    id: "d",
    title: "Check the gap in voice playback",
    state: "failed",
    stateReason: "Process ended without a result",
    startedAt: "2026-11-22T23:59:00Z",
    endedAt: parent.lastActivityAt!,
    seenAt: null,
    taskId: "voice-gap",
  };
  const finished: OtisNode = {
    ...b,
    id: "e",
    title: "Verify the desktop rollback",
    state: "done",
    settled: true,
  };
  return {
    nodes: [
      parent,
      ...roots.slice(1),
      a,
      b,
      c,
      d,
      { ...d, id: "seen", taskId: "seen", title: "Seen failure", seenAt: d.endedAt },
      {
        ...d,
        id: "old",
        title: "Superseded failure",
        startedAt: "2026-11-22T23:58:00Z",
      },
    ],
    a,
    b,
    d,
    finished,
  };
}
it("opens the native parent chat, expands its children, and follows it on desktop and phone", async () => {
  await page.viewport(1280, 844);
  const { nodes, a, b, d, finished } = exampleTree();
  const frames = new TransformStream<OtisFleetEvent, OtisFleetEvent>();
  const writer = frames.writable.getWriter();
  using _rpc = answerRpc("otis.subscribe", ({ read }: { read?: OtisTreeRead }) =>
    read
      ? Stream.make({ type: "read", result: { nodes: [finished], next: null } })
      : Stream.fromReadableStream({ evaluate: () => frames.readable, onError: String }),
  );
  const tail = vi.fn(({ nodeId, after }: OtisTailInput) =>
    Effect.succeed({
      nodeId,
      items: [
        {
          seq: after === undefined ? 10 : 20,
          at: "2026-11-23T00:00:00Z",
          role: "assistant" as const,
          from: "self" as const,
          text: after === undefined ? "Initial parent turn." : "New parent turn.",
          cut: false,
          tool: null,
        },
      ],
      prev: null,
      next: null,
      end: true,
    }),
  );
  using _tailRpc = answerRpc("otis.nodeTail", tail);
  const threads = [
    threadWithHistory("Fleet release verification", 1),
    threadWithHistory("November maintenance schedule", 1),
  ];
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
  await expect.element(page.getByText("Otis tree unavailable. Showing all chats.")).toBeVisible();
  const search = page.getByRole("combobox", { name: "Search threads" });
  await expect.element(search).toBeVisible();
  await writer.write({ type: "snapshot", seq: 1, nodes, waiting: null, load: null });
  await page.getByRole("button", { name: "Expand Otis #1" }).click();
  const lane = page.getByRole("region", { name: "Otis fleet" });
  await expect.element(lane.getByText(a.title)).toBeVisible();
  await expect.element(lane.getByText(d.title)).toBeVisible();
  await expect.element(lane.getByText("Superseded failure")).toBeVisible();
  await expect.element(lane.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await lane.getByRole("button", { name: /^Otis #1/ }).click();
  await expect.element(page.getByRole("heading", { name: "Otis #1" })).toBeVisible();
  await expect.element(page.getByText("Initial parent turn.")).toBeVisible();
  expect(router.state.location.pathname).toBe("/otis/node/lane%3Aotis-1");
  expect(tail).toHaveBeenCalledExactlyOnceWith({ nodeId: "lane:otis-1" });
  const order = () =>
    Array.from(
      lane.element().querySelectorAll("[data-fleet-row]"),
      (row) => row.querySelector(".truncate")?.textContent,
    );
  const original = order();
  await expect.element(page.getByRole("button", { name: "Done · 1" })).toBeVisible();
  await page.screenshot({
    element: document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!,
    path: "__screenshots__/fleet-v1-desktop.png",
  });
  await writer.write({
    type: "delta",
    seq: 2,
    nodes: [
      {
        ...nodes[0]!,
        tailSeq: 20,
        rev: nodes[0]!.rev + 1,
        lastActivityAt: "2026-11-23T00:01:00Z",
      },
      { ...a, waiting: 1, rev: a.rev + 1 },
      { ...b, tokens: { in: 100000, out: 0, cached: 0, total: 100000 }, rev: b.rev + 1 },
    ],
  });
  await expect.element(page.getByText("New parent turn.")).toBeVisible();
  await expect
    .element(lane.getByRole("button", { name: "Retry", exact: true }))
    .not.toBeInTheDocument();
  expect(tail).toHaveBeenLastCalledWith({ nodeId: "lane:otis-1", after: 10 });
  await expect
    .element(lane.getByRole("button", { name: new RegExp(b.title) }).getByText(/\$3\.10/))
    .toBeVisible();
  expect(order()).toEqual(original);
  await page.getByRole("button", { name: /Other chats/ }).click();
  await expect.element(search).toBeVisible();
  await page.getByRole("button", { name: "Back to Otis fleet" }).click();
  await expect.element(lane.getByRole("button", { name: "Collapse Otis #1" })).toBeVisible();
  await lane.getByRole("button", { name: "Done · 1" }).click();
  await expect.element(lane.getByText(finished.title)).toBeVisible();
  await page.viewport(390, 844);
  await page
    .getByRole("button", { name: /Toggle main sidebar/ })
    .first()
    .click();
  await expect.element(lane.getByText(a.title)).not.toBeInTheDocument();
  await lane.getByRole("button", { name: "Expand Otis #1" }).click();
  await expect.element(lane.getByText(a.title)).toBeVisible();
  await expect.element(lane.getByText("Facilities")).not.toBeInTheDocument();
  const meta = lane.getByText(/Astra \u00b7 2 running/);
  await expect.element(meta).toBeVisible();
  expect(meta.element().scrollHeight).toBe(meta.element().clientHeight);
  expect(meta.element().textContent).not.toMatch(/46|312/);
  await expect.element(lane.getByRole("button", { name: "Done · 1" })).toBeVisible();
  await page.screenshot({ path: "__screenshots__/fleet-v1-phone.png" });
  await lane.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Otis #1" })).toBeVisible();
  await expect.element(lane).not.toBeInTheDocument();
  await page
    .getByRole("button", { name: /Toggle main sidebar/ })
    .first()
    .click();
  await lane.getByRole("button", { name: "Back from Otis #1" }).click();
  await lane.getByRole("button", { name: "Expand Otis #1" }).click();
  await lane.getByRole("button", { name: new RegExp(a.title) }).click();
  await expect
    .poll(() => router.state.location.pathname)
    .toBe(`/${ENVIRONMENT_ID}/November maintenance schedule`);
});

it("opens the same Otis row menu by right click, keyboard, and touch hold", async () => {
  window.localStorage.removeItem("otis.fleet.expanded." + ENVIRONMENT_ID);
  await page.viewport(1280, 844);
  const { nodes, a } = exampleTree();
  using _rpc = answerRpc("otis.subscribe", () =>
    Stream.concat(
      Stream.make({ type: "snapshot", seq: 1, nodes, waiting: null, load: null } as const),
      Stream.never,
    ),
  );
  const thread = threadWithHistory("Fleet menu verification", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    panelAnimationDurationMs: 0,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const lane = page.getByRole("region", { name: "Otis fleet" });
  const parent = lane.getByRole("button", { name: /^Otis #1/ });
  const menu = page.getByRole("menu", { name: "Context menu" });
  await parent.click({ button: "right" });
  await expect.element(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  expect(menu.element().querySelector("svg")).toBeNull();
  (document.activeElement as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await expect.element(menu).not.toBeInTheDocument();

  const parentElement = parent.element() as HTMLElement;
  parentElement.focus();
  parentElement.dispatchEvent(
    new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
  );
  await expect.element(menu).toHaveFocus();
  menu.element().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  const openChat = menu.getByRole("menuitem", { name: "Open chat" });
  await expect.element(openChat).toHaveFocus();
  openChat.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await expect.poll(() => router.state.location.pathname).toBe("/otis/node/lane%3Aotis-1");

  await lane.getByRole("button", { name: "Expand Otis #1" }).click();
  const worker = lane.getByRole("button", { name: new RegExp(a.title) });
  await expect.element(worker).toBeVisible();
  const workerElement = worker.element();
  const { left, top } = workerElement.getBoundingClientRect();
  workerElement.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: left + 4,
      clientY: top + 4,
    }),
  );
  await expect.element(menu.getByRole("menuitem", { name: "Copy run ID" })).toBeVisible();
  workerElement.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }),
  );
  workerElement.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
  );
  expect(router.state.location.pathname).toBe("/otis/node/lane%3Aotis-1");
});
