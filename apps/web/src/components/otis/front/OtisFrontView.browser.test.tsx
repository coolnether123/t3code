import { createMemoryHistory } from "@tanstack/react-router";
import { OTIS_THREAD_ID, OtisFront, type OtisFrontUpdate } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import "~/index.css";
import { getRouter } from "~/router";
import fixture from "../../../../../../apps/server/src/otis/fixtures/front-events.ndjson?raw";
import {
  answerRpc,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  type FakeDriver,
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

it("opens the Otis route, sends a typed turn and renders fixture updates on desktop and phone", async () => {
  await page.viewport(1440, 900);
  const events = fixture
    .trim()
    .split(/\r?\n/)
    .map(OtisFront.decodeFrontStreamLine)
    .filter(OtisFront.isKnownFrontEvent);
  const state = events.find((event) => event.type === "state")!;
  const greeting = events.find((event) => event.type === "item" && event.item.id === "itm_001")!;
  if (greeting.type !== "item") throw new Error("Missing greeting fixture");
  const frames = new TransformStream<OtisFrontUpdate, OtisFrontUpdate>();
  const writer = frames.writable.getWriter();
  const turn = vi.fn((input: OtisFront.TurnRequest) =>
    Effect.succeed({ turnId: input.clientTurnId }),
  );
  const cancel = vi.fn((input: { turnId: string }) =>
    Effect.succeed({ ...input, cancelled: true }),
  );
  using _subscribe = answerRpc("otis.front.subscribe", () =>
    Stream.fromReadableStream({ evaluate: () => frames.readable, onError: String }),
  );
  using _turn = answerRpc("otis.front.turn", turn);
  using _cancel = answerRpc("otis.front.cancel", cancel);
  using _history = answerRpc("otis.front.history", () => Effect.succeed({ items: [], next: null }));
  using _report = answerRpc("otis.front.report", () => Effect.succeed(null));
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    panelAnimationDurationMs: 0,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${OTIS_THREAD_ID}`] }),
  );
  await router.load();
  // AppRoot supplies its own router.
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await writer.write({ type: "connected", taskDashboardUrl: "https://otis.example/" });
  await writer.write(state);
  const composer = page.getByRole("textbox", { name: "Message Otis" });
  await composer.fill("Hi otis");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect(turn).toHaveBeenCalledExactlyOnceWith({
    channel: "typed",
    text: "Hi otis",
    clientTurnId: expect.any(String),
  });
  await writer.write({ ...greeting, item: { ...greeting.item, text: "Hi otis" } });
  const item = page.getByText("Hi otis", { exact: true });
  await expect.element(item).toBeVisible();
  for (const [width, height, name] of [
    [1440, 900, "desktop"],
    [390, 844, "phone"],
  ] as const) {
    await page.viewport(width, height);
    const status = expect.element(page.getByText("Otis #1 working", { exact: true }));
    if (width === 390) await status.not.toBeVisible();
    else await status.toBeVisible();
    const element = document.querySelector('[data-front-item="itm_001"]')!;
    expect(element.getBoundingClientRect().height).toBeLessThan(
      2 * parseFloat(getComputedStyle(element).lineHeight),
    );
    await page.screenshot({ path: `__screenshots__/otis-front-${name}.png` });
  }
  await writer.write(events.find((event) => event.seq === 3)!);
  await writer.write(events.find((event) => event.seq === 4)!);
  await expect.element(page.getByText("Four things.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ turnId: "turn_001" });
  for (const event of events.filter((event) => event.seq >= 5 && event.seq <= 20)) {
    await writer.write(event);
    const status = new Map([
      [8, "Sent"],
      [10, "Waiting on the matrix"],
      [20, "Done"],
    ]).get(event.seq);
    if (status) {
      const card = page.getByText("Handoff to Otis #1", { exact: true });
      await expect.element(card).toBeInTheDocument();
      await expect.element(page.getByText(status, { exact: true })).toBeVisible();
      expect(document.querySelectorAll('[data-front-card="card_h_3fa91c02"]')).toHaveLength(1);
    }
  }
  await expect.element(page.getByText("Price watch: 16 TB drive")).toBeInTheDocument();
  await expect.element(page.getByText("Guess", { exact: true })).toBeInTheDocument();
  const task = page.getByRole("link", { name: "Sheltered 1.7 release" });
  await expect.element(task).toBeInTheDocument();
  expect(task.element().getAttribute("href")).toMatch(
    /^https:\/\/otis\.example\/#tracker\?task=agenda-task%3A/,
  );
  await page.screenshot({ path: "__screenshots__/otis-front-cards-phone.png" });
  await page.viewport(1440, 900);
  await page.screenshot({ path: "__screenshots__/otis-front-cards-desktop.png" });
  await writer.write({ type: "unavailable" });
  await expect.element(page.getByText("Can't reach Otis right now. Retrying.")).toBeVisible();
  await expect.element(item).toBeInTheDocument();
  await writer.write({ ...state, seq: 100 });
  await expect
    .element(page.getByText("Can't reach Otis right now. Retrying."))
    .not.toBeInTheDocument();
});
