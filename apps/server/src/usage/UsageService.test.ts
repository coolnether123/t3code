// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { UsageDay, type UsageSummary, type UsageSummaryInput } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function codexTranscript(sessionId: string, outputTokens: number, turnId?: string): string {
  return [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-01T10:00:00Z",
      payload: { type: "session_meta", id: sessionId },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-01T10:00:01Z",
      payload: {
        type: "turn_context",
        model: "gpt-5.6-sol",
        ...(turnId === undefined ? {} : { turn_id: turnId }),
      },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T10:00:02Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: outputTokens,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
  ].join("\n");
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly configBaseDir?: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  readonly neverRates?: boolean;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
}) =>
  ServerConfig.layerTest(process.cwd(), input.configBaseDir ?? { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }).pipe(
            Effect.flatMap((response) =>
              input.neverRates === true ? Effect.never : Effect.succeed(response),
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, { GROK_HOME: NodePath.join(input.home, "grok") }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("uses cached disk rates for the first summary", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const configBaseDir = NodePath.join(home, "usage-service-cached-rates-state");
      const stateDir = NodePath.join(configBaseDir, "userdata");
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-model-rates.json"),
          '{"fetchedAtMs":1700000000000,"document":{"claude-fable-5":{"input_cost_per_token":0.00001,"output_cost_per_token":0.00005}}}',
        ),
      );
      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-cached-rates-test",
            home,
            settings,
            configBaseDir,
            neverRates: true,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(summary.pricing.status, "cached");
      assert.strictEqual(summary.pricing.knownModels, 1);
      assert.closeTo(summary.buckets[0]?.costUsd ?? -1, 0.00035, 1e-12);
      assert.strictEqual(summary.buckets[0]?.unpricedRecords, 0);
      assert.strictEqual(ratesFetches, 1);
    }).pipe(Effect.scoped),
  );

  it.live("does not let a stalled rates request consume the usage read budget", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-stalled-rates-test",
            home,
            settings,
            neverRates: true,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const result = yield* service.readSummary(WINDOW).pipe(Effect.timeoutOption(2_000));
      assert.isTrue(result._tag === "Some", "usage read should finish while rates are stalled");
      if (result._tag === "Some") {
        assert.strictEqual(result.value.buckets[0]?.unpricedRecords, 1);
        assert.strictEqual(result.value.pricing.knownModels, 0);
      }
      assert.strictEqual(ratesFetches, 1);
    }).pipe(Effect.scoped),
  );

  it.live("counts a migrated rollout once across shared and isolated homes", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const sharedFile = NodePath.join(
          home,
          "codex",
          "sessions",
          "2026",
          "08",
          "rollout-2026-08-01T10-00-00-019e487f-1234-7abc-8def-0123456789ab.jsonl",
        );
        const isolatedFile = NodePath.join(
          serverConfig.baseDir,
          "codex-home",
          "codex",
          "sessions",
          "2026",
          "08",
          "rollout-2026-08-01T10-00-00-019e487f-1234-7abc-8def-0123456789ab.jsonl",
        );
        const contents = codexTranscript("019e487f-1234-7abc-8def-0123456789ab", 10);
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.dirname(sharedFile), { recursive: true }),
        );
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.dirname(isolatedFile), { recursive: true }),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(sharedFile, contents));
        yield* Effect.promise(() => NodeFSP.writeFile(isolatedFile, contents));

        const service = yield* UsageService.make;
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 10);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          serviceLayers({ prefix: "usage-service-codex-isolation-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("returns an idempotent native session and turn attribution", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const sessions = NodePath.join(home, "codex", "sessions", "2026", "08");
      yield* Effect.promise(() => NodeFSP.mkdir(sessions, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(
            sessions,
            "rollout-2026-08-01T10-00-00-019e487f-1234-7abc-8def-000000000001.jsonl",
          ),
          codexTranscript("parent-session", 30, "parent-turn"),
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(
            sessions,
            "rollout-2026-08-01T10-01-00-019e487f-1234-7abc-8def-000000000002.jsonl",
          ),
          codexTranscript("child-session", 20, "child-turn"),
        ),
      );

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-attribution-test",
            home,
            settings,
            ratesDocument: {
              "gpt-5.6-sol": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
            },
          }),
        ),
      );
      const input: UsageSummaryInput = {
        ...WINDOW,
        providers: ["codex"],
        sessionIds: ["child-session"],
        turnIds: ["child-turn"],
        groupBy: "turn",
      };
      yield* service.refreshRates;
      const first = yield* service.readSummary(input);
      const replay = yield* service.readSummary(input);

      assert.deepStrictEqual(replay.buckets, first.buckets);
      assert.lengthOf(first.buckets, 1);
      assert.deepInclude(first.buckets[0], {
        day: UsageDay.make("2026-08-01"),
        provider: "codex",
        model: "gpt-5.6-sol",
        sessionId: "child-session",
        turnId: "child-turn",
        serviceTier: "unknown",
        serviceTierSource: "unknown",
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
        },
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      });
      assert.closeTo(first.buckets[0]?.costUsd ?? -1, 0.00005, 1e-12);
      assert.strictEqual(
        first.sources.every((source) => source.fingerprint.provider === "codex"),
        true,
      );
      assert.match(first.pricing.revision ?? "", /^[a-f0-9]{64}$/);
    }).pipe(Effect.scoped),
  );

  it.live("projects repeated Codex input separately from the full session total", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex");
      const skillPath = NodePath.join(codexHome, "skills", "unslop", "SKILL.md");
      const unusedSkillPath = NodePath.join(codexHome, "skills", "never-used", "SKILL.md");
      const sessions = NodePath.join(codexHome, "sessions", "2026", "08");
      const skillText = "# Unslop\nUse plain language.\n";
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(skillPath), { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(unusedSkillPath), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.mkdir(sessions, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(skillPath, skillText));
      yield* Effect.promise(() => NodeFSP.writeFile(unusedSkillPath, "# Never used\n"));
      const transcript = [
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Transcript fixture is JSONL.
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-08-01T10:00:00Z",
          payload: { type: "session_meta", id: "repeated-session", cwd: "C:/project" },
        }),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Transcript fixture is JSONL.
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-08-01T10:00:01Z",
          payload: { type: "turn_context", model: "gpt-5.6-sol", turn_id: "repeated-turn" },
        }),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Transcript fixture is JSONL.
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-01T10:00:02Z",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                cache_write_input_tokens: 10,
                output_tokens: 2,
                reasoning_output_tokens: 0,
              },
            },
          },
        }),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Transcript fixture is JSONL.
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-01T10:00:03Z",
          payload: {
            type: "function_call_output",
            id: "skill-read-1",
            costUSD: 0.25,
            output: skillText,
          },
        }),
      ].join("\n");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(sessions, "rollout-2026-08-01T10-00-00-repeated-session.jsonl"),
          transcript,
        ),
      );

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-repeated-input-test",
            home,
            settings,
            ratesDocument: {
              "gpt-5.6-sol": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
            },
          }),
        ),
      );
      yield* service.refreshRates;
      const ordinary = yield* service.readSummary({
        ...WINDOW,
        providers: ["codex"],
        groupBy: "turn",
      } as UsageSummaryInput);
      const summary = yield* service.readSummary({
        ...WINDOW,
        providers: ["codex"],
        groupBy: "turn",
        includeRepeatedInput: true,
      } as UsageSummaryInput);
      assert.deepStrictEqual(summary.buckets, ordinary.buckets);
      assert.deepStrictEqual(summary.sources, ordinary.sources);
      assert.deepStrictEqual(summary.pricing, ordinary.pricing);
      assert.deepInclude(summary.buckets[0], {
        totals: {
          uncachedInputTokens: 50,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 2,
          reasoningTokens: 0,
        },
      });
      const repeated = summary.repeatedInput;
      assert.ok(repeated);
      assert.lengthOf(repeated.items, 1);
      assert.lengthOf(repeated.catalog ?? [], 2);
      assert.deepInclude(repeated.catalog?.[0], {
        displayName: "unslop",
        observed: true,
        confidence: "confirmedPayload",
      });
      assert.isString(repeated.catalog?.[0]?.firstObservedAt);
      assert.isString(repeated.catalog?.[0]?.lastObservedAt);
      assert.deepInclude(
        repeated.catalog?.find((item) => item.displayName === "never-used"),
        {
          observed: false,
          firstObservedAt: null,
          lastObservedAt: null,
          confidence: null,
          occurrences: 0,
          estimatedApiCostUsd: null,
        },
      );
      assert.strictEqual(repeated.items[0]?.sourceKind, "skill");
      assert.strictEqual(repeated.items[0]?.displayName, "unslop");
      assert.strictEqual(repeated.items[0]?.occurrences, 1);
      assert.strictEqual(repeated.items[0]?.fullSessionInputTokens.exact, 50);
      assert.strictEqual(repeated.items[0]?.fullSessionInputTokens.cached, 40);
      assert.strictEqual(repeated.items[0]?.fullSessionInputTokens.cacheWrite, 10);
      assert.isAtLeast(
        (repeated.items[0]?.directTokens.exact ?? 0) +
          (repeated.items[0]?.directTokens.estimated ?? 0),
        0,
      );
      assert.isNotNull(repeated.items[0]?.modelCosts[0]?.estimatedApiCostUsd);
      assert.strictEqual(repeated.items[0]?.modelCosts[0]?.estimatedApiCostUsd, 0.25);
      assert.strictEqual(repeated.items[0]?.modelCosts[0]?.priceStatus, "providerReported");

      // Quota history is the reset-monitor projection, not ordinary Usage.
      // An opt-in repeated-input flag must not route data through that path.
      const historyOnly = yield* service.readSummary({
        ...WINDOW,
        providers: ["codex"],
        includeRepeatedInput: true,
        quotaHistoryOnly: true,
      } as UsageSummaryInput);
      assert.isUndefined(
        (historyOnly as UsageSummary & { readonly repeatedInput?: unknown }).repeatedInput,
      );
      const quotaProjection = yield* service.readSummary({
        ...WINDOW,
        providers: ["codex"],
        includeRepeatedInput: true,
        quotaIntervals: [],
      } as UsageSummaryInput);
      assert.isUndefined(
        (quotaProjection as UsageSummary & { readonly repeatedInput?: unknown }).repeatedInput,
      );
    }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          serviceLayers({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-grow-test", home, settings })),
      );

      yield* service.refreshRates;
      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const firstScanStarted = yield* Deferred.make<void>();
        const secondScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        let homeProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== NodePath.join(home, "claude", ".claude", "projects"))
                    return Effect.void;
                  homeProbes += 1;
                  return Deferred.succeed(
                    homeProbes === 1 ? firstScanStarted : secondScanStarted,
                    undefined,
                  );
                }),
              ),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.await(releaseRates).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstScanStarted);
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(secondScanStarted);
        yield* Deferred.succeed(releaseRates, undefined);

        const original = yield* Fiber.join(first);
        const updated = yield* Fiber.join(second);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(
        Effect.scoped,
        Effect.provide(serviceLayers({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request is fresh work again, not a stale cached answer.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      yield* service.refreshRates;
      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-interruption-test", home, settings }),
        ),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});
