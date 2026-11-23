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

import type { OtisFleetEvent, OtisNode, OtisTreeRead } from "@t3tools/contracts";
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
  const parent = { ...roots[0]!, sub: { ...base.sub, nodes: 5, running: 2 } };
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
  };
  const finished: OtisNode = {
    ...b,
    id: "e",
    title: "Verify the desktop rollback",
    state: "done",
    settled: true,
  };
  return { nodes: [parent, ...roots.slice(1), a, b, c, d], a, b, finished };
}
it("keeps fleet rows in place, returns from stock, and drills into one phone level", async () => {
  await page.viewport(1280, 844);
  const { nodes, a, b, finished } = exampleTree();
  const frames = new TransformStream<OtisFleetEvent, OtisFleetEvent>();
  const writer = frames.writable.getWriter();
  using _rpc = answerRpc("otis.subscribe", ({ read }: { read?: OtisTreeRead }) =>
    read
      ? Stream.make({ type: "read", result: { nodes: [finished], next: null } })
      : Stream.fromReadableStream({ evaluate: () => frames.readable, onError: String }),
  );
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
      { ...a, waiting: 1, rev: a.rev + 1 },
      { ...b, tokens: { in: 100000, out: 0, cached: 0, total: 100000 }, rev: b.rev + 1 },
    ],
  });
  await expect.element(lane.getByText("Sol 6.2 · 100k")).toBeVisible();
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
  await lane.getByRole("button", { name: /Otis #1/ }).click();
  await expect.element(lane.getByText(a.title)).toBeVisible();
  await expect.element(lane.getByText("Facilities")).not.toBeInTheDocument();
  await expect.element(lane.getByRole("button", { name: "Done · 1" })).toBeVisible();
  await page.screenshot({ path: "__screenshots__/fleet-v1-phone.png" });
  await lane.getByRole("button", { name: "Back from Otis #1" }).click();
  await lane.getByRole("button", { name: /Otis #1/ }).click();
  await lane.getByRole("button", { name: new RegExp(a.title) }).click();
  await expect
    .poll(() => router.state.location.pathname)
    .toBe(`/${ENVIRONMENT_ID}/November maintenance schedule`);
});
