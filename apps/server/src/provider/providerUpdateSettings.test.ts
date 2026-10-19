import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";

const readSnapshot = (settings: ServerSettings) =>
  makeProviderSnapshotSettingsSource({}).pipe(
    Effect.flatMap((source) => source.getSettings),
    Effect.provide(
      Layer.mock(ProviderHost.ProviderHost)({
        paths: {
          cwd: "/synthetic",
          baseDir: "/synthetic",
          stateDir: "/synthetic",
          providerStatusCacheDir: "/synthetic",
          attachmentsDir: "/synthetic",
        },
        resolveAttachmentPath: () => null,
        settings: {
          get: Effect.succeed(settings),
          changes: Stream.empty,
          subscribe: Effect.succeed(Stream.empty),
          withSnapshot: (use) => use(settings),
        },
      }),
    ),
  );

it.effect("refreshes provider snapshots when browser access changes", () =>
  Effect.gen(function* () {
    const enabled = yield* readSnapshot({
      ...DEFAULT_SERVER_SETTINGS,
      enableAgentBrowserAccess: true,
    });
    const disabled = yield* readSnapshot({
      ...DEFAULT_SERVER_SETTINGS,
      enableAgentBrowserAccess: false,
    });
    expect(haveProviderSnapshotSettingsChanged(enabled, disabled)).toBe(true);
    expect(haveProviderSnapshotSettingsChanged(disabled, enabled)).toBe(true);
    expect(
      haveProviderSnapshotSettingsChanged(
        enabled,
        yield* readSnapshot({ ...DEFAULT_SERVER_SETTINGS, enableAgentBrowserAccess: true }),
      ),
    ).toBe(false);
  }),
);
