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
    nodes: nodes.map((node) => (node.id === worker.id ? worker : node)),
    waiting: null,
    load: null,
  });
  const workers = page.getByRole("region", { name: "Otis workers" });
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
    seq: 2,
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
