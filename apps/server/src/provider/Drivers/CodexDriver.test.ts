import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type PreviewAutomationHost,
  type ServerProvider,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { afterEach, vi } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ChromeAutomation from "../../browser/ChromeAutomation.ts";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as CodexProvider from "../Layers/CodexProvider.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CODEX_COMPUTER_CONTROL_OPTION_ID } from "../CodexComputerControl.ts";
import { CodexDriver } from "./CodexDriver.ts";

const environmentId = EnvironmentId.make("driver-environment");
const model = {
  id: "test-model",
  model: "test-model",
  displayName: "Test model",
  description: "Test model",
  hidden: false,
  isDefault: true,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "low",
  inputModalities: ["text"],
  supportsPersonality: false,
} as const;

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "codex-browser-readiness" }).pipe(
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP request")),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

const browserOptions = (snapshot: ServerProvider) => {
  const capabilities = snapshot.models[0]?.capabilities;
  const descriptor =
    capabilities &&
    getProviderOptionDescriptors({ caps: capabilities }).find(
      (option) => option.id === CODEX_COMPUTER_CONTROL_OPTION_ID,
    );
  return descriptor && descriptor.type === "select"
    ? descriptor.options.map((option) => option.id)
    : [];
};

const connectHost = Effect.fn(function* (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  host: PreviewAutomationHost,
) {
  const connected = yield* Deferred.make<void>();
  const stream = yield* broker.connect(host);
  const fiber = yield* stream.pipe(
    Stream.runForEach((event) =>
      event.type === "connected" ? Deferred.succeed(connected, undefined) : Effect.void,
    ),
    Effect.forkScoped,
  );
  yield* Deferred.await(connected);
  return fiber;
});

const createInstance = Effect.fn(function* () {
  const settings = yield* SubscriptionRef.make({
    ...DEFAULT_SERVER_SETTINGS,
    enableAgentBrowserAccess: true,
    enableProviderUpdateChecks: false,
  });
  const instance = yield* CodexDriver.create({
    instanceId: ProviderInstanceId.make("codex-test"),
    displayName: undefined,
    enabled: true,
    environment: [],
    config: { ...CodexDriver.defaultConfig(), binaryPath: "missing-codex-readiness-test" },
  }).pipe(
    Effect.provide(
      Layer.mock(ServerSettingsService)({
        getSettings: SubscriptionRef.get(settings),
        streamChanges: SubscriptionRef.changes(settings),
        subscribeChanges: Effect.succeed(SubscriptionRef.changes(settings)),
      }),
    ),
  );
  return { instance, settings };
});

function stubProvider(chromeInstalled: boolean) {
  vi.spyOn(ChromeAutomation, "findInstalledChrome").mockImplementation(() =>
    Effect.succeed(chromeInstalled ? "/test/chrome" : undefined),
  );
  vi.spyOn(CodexProvider, "checkCodexProviderStatus").mockImplementation(
    (_settings, _probe, _environment, browserTools) =>
      Effect.succeed({
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-08-30T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: [
          {
            slug: model.model,
            name: model.displayName,
            isCustom: false,
            capabilities: CodexProvider.mapCodexModelCapabilities(model, browserTools),
          },
        ],
      }),
  );
}

afterEach(() => vi.restoreAllMocks());

it.effect("refreshes Preview on host and setting changes while keeping Chrome independent", () =>
  Effect.gen(function* () {
    stubProvider(true);
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    yield* connectHost(broker, {
      clientId: "foreign",
      environmentId: EnvironmentId.make("foreign"),
    });
    const { instance, settings } = yield* createInstance();
    const snapshots = yield* Queue.unbounded<ServerProvider>();
    const subscribed = yield* Deferred.make<void>();
    yield* instance.snapshot.streamChanges.pipe(
      Stream.onStart(Deferred.succeed(subscribed, undefined)),
      Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    expect(browserOptions(yield* instance.snapshot.refresh)).toEqual(["chrome"]);
    const awaitOptions = (expected: string[]) =>
      Stream.fromQueue(snapshots).pipe(
        Stream.filter(
          (snapshot) => JSON.stringify(browserOptions(snapshot)) === JSON.stringify(expected),
        ),
        Stream.runHead,
      );
    yield* awaitOptions(["chrome"]);

    const host = yield* connectHost(broker, { clientId: "desktop", environmentId });
    yield* awaitOptions(["chrome", "preview"]);
    expect(browserOptions(yield* instance.snapshot.getSnapshot)).toEqual(["chrome", "preview"]);
    yield* SubscriptionRef.update(settings, (current) => ({
      ...current,
      enableAgentBrowserAccess: false,
    }));
    yield* awaitOptions(["chrome"]);
    yield* SubscriptionRef.update(settings, (current) => ({
      ...current,
      enableAgentBrowserAccess: true,
    }));
    yield* awaitOptions(["chrome", "preview"]);
    yield* Fiber.interrupt(host);
    yield* awaitOptions(["chrome"]);
    expect(browserOptions(yield* instance.snapshot.getSnapshot)).toEqual(["chrome"]);
    yield* connectHost(broker, { clientId: "desktop", environmentId });
    yield* awaitOptions(["chrome", "preview"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("starts with an already-connected Preview host and no Chrome executable", () =>
  Effect.gen(function* () {
    stubProvider(false);
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const host = yield* connectHost(broker, { clientId: "desktop", environmentId });
    const { instance } = yield* createInstance();
    expect(browserOptions(yield* instance.snapshot.refresh)).toEqual(["preview"]);
    yield* Fiber.interrupt(host);
    expect(browserOptions(yield* instance.snapshot.refresh)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
