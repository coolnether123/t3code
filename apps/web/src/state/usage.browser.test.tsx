import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

const testState = vi.hoisted(() => ({ environments: [] as EnvironmentUsageStatus[] }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => testState.environments,
}));

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

function environment(
  id: string,
  cost: number | null,
  hostId = id,
  provider: UsageProviderKind = "codex",
): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: "connected", error: null, traceId: null },
    isPending: cost === null,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    needsCursorKeychainAccess: false,
    summary:
      cost === null
        ? null
        : {
            ...input,
            contractVersion: USAGE_CONTRACT_VERSION,
            readAt: "2026-09-04T12:00:00Z",
            buckets: [
              {
                day: input.sinceDay,
                provider,
                model: id,
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 50,
                  reasoningTokens: 0,
                },
                costUsd: cost,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId,
                  provider,
                  resolvedHomePath: "/sessions",
                  volumeId: hostId,
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
            scanDurationMs: 1,
          },
  };
}

type ProbeProps = {
  selected: ReadonlySet<EnvironmentId> | null;
  hidden?: ReadonlySet<UsageProviderKind>;
  window?: typeof input;
};

function Probe({
  selected,
  hidden,
  window = input,
  onUsage,
}: ProbeProps & { onUsage: (usage: UsageView) => void }) {
  const usage = useUsage(window, selected, hidden);
  useLayoutEffect(() => {
    onUsage(usage);
  }, [usage, onUsage]);
  return null;
}

async function setup() {
  testState.environments = [environment("a", 10), environment("b", 20), environment("slow", null)];
  let latest: UsageView | undefined;
  const onUsage = (usage: UsageView) => {
    latest = usage;
  };
  await using scope = new AsyncDisposableStack();
  // This hook probe has no links or navigation and reads its result immediately after mounting.
  const screen = scope.use(
    await render(<Probe selected={null} onUsage={onUsage} />, { router: false }),
  );
  const rerender = (props: ProbeProps) => screen.rerender(<Probe {...props} onUsage={onUsage} />);
  const resources = scope.move();
  return {
    get latest() {
      if (!latest) throw new Error("Usage probe has not rendered.");
      return latest;
    },
    rerender,
    select: (...ids: string[]) =>
      rerender({ selected: new Set(ids.map((id) => EnvironmentId.make(id))) }),
    [Symbol.asyncDispose]: () => resources[Symbol.asyncDispose](),
  };
}

describe("usage environment selection", () => {
  it("starts with all environments and adds results as they arrive", async () => {
    await using fixture = await setup();
    expect(fixture.latest.merged.costUsd).toBe(30);
    expect(fixture.latest.isPending).toBe(false);
    expect(fixture.latest.isPartial).toBe(true);

    testState.environments = [...testState.environments.slice(0, 2), environment("slow", 40)];
    await fixture.rerender({ selected: null });
    expect(fixture.latest.merged.costUsd).toBe(70);
    expect(fixture.latest.isPartial).toBe(false);
  });

  it("excludes unselected usage and pending environments, then restores all", async () => {
    await using fixture = await setup();
    await fixture.select("b");
    expect(fixture.latest.merged.costUsd).toBe(20);
    expect(fixture.latest.merged.models.map((model) => model.model)).toEqual(["b"]);
    expect(fixture.latest.isPending).toBe(false);
    expect(fixture.latest.isPartial).toBe(false);
    expect(fixture.latest.environments).toHaveLength(3);

    await fixture.rerender({ selected: null });
    expect(fixture.latest.merged.costUsd).toBe(30);
    expect(fixture.latest.isPartial).toBe(true);
  });

  it("distinguishes a pending selection from an empty or failed selection", async () => {
    await using fixture = await setup();
    await fixture.select("slow");
    expect(fixture.latest.isPending).toBe(true);
    expect(fixture.latest.merged.costUsd).toBe(0);

    await fixture.select();
    expect(fixture.latest.selectedEnvironments).toHaveLength(0);
    expect(fixture.latest.isPending).toBe(false);
    expect(fixture.latest.isPartial).toBe(false);

    testState.environments = [{ ...environment("slow", null), isPending: false, error: "Offline" }];
    await fixture.select("slow");
    expect(fixture.latest.isPending).toBe(false);
    expect(fixture.latest.isPartial).toBe(false);
  });

  it("deduplicates within the selection so an excluded owner cannot hide usage", async () => {
    await using fixture = await setup();
    testState.environments = [environment("a", 10, "shared"), environment("b", 20, "shared")];
    await fixture.rerender({ selected: null });
    expect(fixture.latest.merged.costUsd).toBe(10);

    await fixture.select("b");
    expect(fixture.latest.merged.costUsd).toBe(20);
    expect(fixture.latest.merged.duplicateSources).toEqual([]);
  });

  it("keeps selected cached results visible during a refresh", async () => {
    await using fixture = await setup();
    testState.environments = [
      { ...environment("a", 10), isPending: true },
      environment("slow", null),
    ];
    await fixture.select("a");
    expect(fixture.latest.merged.costUsd).toBe(10);
    expect(fixture.latest.isPending).toBe(false);
    expect(fixture.latest.isPartial).toBe(false);
  });

  it("shows the last answered usage until the next window answers, for the same selection", async () => {
    await using fixture = await setup();
    const selected = new Set([EnvironmentId.make("a")]);
    await fixture.rerender({ selected });
    expect(fixture.latest.shown?.merged.costUsd).toBe(10);

    const nextWindow = { ...input, sinceDay: UsageDay.make("2026-08-28") };
    testState.environments = [environment("a", null)];
    await fixture.rerender({ selected, window: nextWindow });
    expect(fixture.latest.isPending).toBe(true);
    expect(fixture.latest.shown?.window).toBe(input);
    expect(fixture.latest.shown?.merged.costUsd).toBe(10);

    testState.environments = [{ ...environment("a", null), isPending: false, error: "Offline" }];
    await fixture.rerender({ selected, window: nextWindow });
    expect(fixture.latest.isPending).toBe(false);
    expect(fixture.latest.shown?.window).toBe(input);
    expect(fixture.latest.shown?.merged.costUsd).toBe(10);

    testState.environments = [environment("a", 30)];
    await fixture.rerender({ selected, window: nextWindow });
    expect(fixture.latest.shown?.window).toBe(nextWindow);
    expect(fixture.latest.shown?.merged.costUsd).toBe(30);

    const answeredWindow = { ...nextWindow, sinceDay: UsageDay.make("2026-08-27") };
    await fixture.rerender({ selected, window: answeredWindow });
    testState.environments = [environment("a", null)];
    await fixture.rerender({ selected, window: answeredWindow });
    expect(fixture.latest.shown?.window).toBe(answeredWindow);
    expect(fixture.latest.shown?.merged.costUsd).toBe(30);

    testState.environments = [environment("a", null)];
    await fixture.rerender({ selected, hidden: new Set(["claude"]), window: input });
    expect(fixture.latest.shown).toBeNull();

    testState.environments = [environment("a", null)];
    await fixture.select("a");
    expect(fixture.latest.shown).toBeNull();
  });
});

describe("usage provider filter", () => {
  it("drops hidden providers from totals and sessions, then restores them", async () => {
    await using fixture = await setup();
    testState.environments = [environment("a", 10), environment("c", 5, "c", "claude")];
    await fixture.rerender({ selected: null, hidden: new Set(["codex"]) });
    expect(fixture.latest.merged.costUsd).toBe(5);
    expect(fixture.latest.merged.sessions).toBe(1);
    expect(fixture.latest.merged.providers.map((entry) => entry.provider)).toEqual(["claude"]);

    await fixture.rerender({ selected: null });
    expect(fixture.latest.merged.costUsd).toBe(15);
    expect(fixture.latest.merged.sessions).toBe(2);
  });
});
