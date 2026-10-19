import type { ProviderInstanceConfig, ServerSettings, UsageProviderKind } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type { ProviderUsageInstance, ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BUILT_IN_USAGE_DRIVERS, type BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import {
  listTranscriptFiles,
  readTranscriptRecords as readProviderTranscriptRecords,
  type TranscriptParseResult,
} from "./usageProviderTranscriptReader.ts";

// Codex and Claude retain the fork's bounded, resumable scanner and native attribution.
const readers = BUILT_IN_USAGE_DRIVERS.filter(
  (driver) => driver.usage !== undefined && !["codex", "claude"].includes(driver.usage.provider),
);

export const makeProviderUsageReader = Effect.gen(function* () {
  const hostEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const context = yield* Effect.context<BuiltInUsageReadersEnv>();
  const transcripts = new Map<
    string,
    {
      readonly size: number;
      readonly mtimeMs: number;
      readonly parsed: TranscriptParseResult;
    }
  >();
  const instancesFor = Effect.fnUntraced(function* <Config>(
    driver: ProviderDriver<Config, unknown, unknown>,
    settings: ServerSettings,
  ) {
    const entries: Array<
      readonly [ProviderInstanceId, Pick<ProviderInstanceConfig, "config" | "environment">, boolean]
    > = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === driver.driverKind)
      .map(([id, instance]) => [ProviderInstanceId.make(id), instance, true] as const);
    if (!Object.hasOwn(settings.providerInstances, driver.driverKind)) {
      entries.push([ProviderInstanceId.make(driver.driverKind), {}, false]);
    }
    const decode = Schema.decodeUnknownOption(driver.configSchema);
    return yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([instanceId, instance, configured]) {
        return {
          instanceId,
          config: Option.getOrUndefined(decode(instance.config ?? {})),
          environment: yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ),
          configured,
        } satisfies ProviderUsageInstance<Config>;
      }),
    );
  });

  return (input: {
    readonly settings: ServerSettings;
    readonly windowStartMs: number;
    readonly retentionCutoffMs: number;
    readonly awaitRefresh: boolean;
    readonly providers?: readonly UsageProviderKind[];
  }) =>
    Effect.forEach(
      readers,
      Effect.fnUntraced(function* (driver) {
        const reader = driver.usage;
        if (
          reader === undefined ||
          (input.providers !== undefined && !input.providers.includes(reader.provider))
        )
          return [];
        const instances = yield* instancesFor(driver, input.settings);
        let sources: readonly ProviderUsageScan[];
        if (reader.kind === "scan") {
          sources = yield* reader.scan({ ...input, instances });
        } else {
          const directories = yield* Effect.forEach(
            (yield* Effect.forEach(instances, reader.directories)).flat(),
            (directory) =>
              fileSystem.realPath(directory.dir).pipe(
                Effect.orElseSucceed(() => directory.dir),
                Effect.map((dir) => ({ ...directory, dir })),
              ),
          );
          const seen = new Set<string>();
          sources = yield* Effect.forEach(
            directories.filter(({ dir }) => {
              if (seen.has(dir)) return false;
              seen.add(dir);
              return true;
            }),
            Effect.fnUntraced(function* ({ dir, fileName }) {
              if (!(yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false))))
                return { dir, files: null };
              const listing = yield* Effect.promise(() =>
                listTranscriptFiles(
                  dir,
                  input.windowStartMs,
                  fileName === undefined ? undefined : { fileName },
                ),
              );
              const files = listing.files;
              const parsed = yield* Effect.forEach(
                files,
                (file) =>
                  Effect.promise(async () => ({
                    path: file.path,
                    records: await (async () => {
                      const key = `${reader.provider}\0${file.path}`;
                      const cached = transcripts.get(key);
                      if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs)
                        return [...cached.parsed.records, ...cached.parsed.tailRecords];
                      const parsed = await readProviderTranscriptRecords(
                        file.path,
                        reader.format,
                        cached !== undefined && file.size > cached.size
                          ? cached.parsed.position
                          : undefined,
                      );
                      if (parsed === null) return null;
                      const records =
                        parsed.resumed && cached !== undefined
                          ? [...cached.parsed.records, ...parsed.records]
                          : parsed.records;
                      transcripts.set(key, {
                        size: file.size,
                        mtimeMs: file.mtimeMs,
                        parsed: { ...parsed, records },
                      });
                      return [...records, ...parsed.tailRecords];
                    })(),
                  })),
                { concurrency: 4 },
              );
              const failed =
                listing.failedPaths + parsed.filter((file) => file.records === null).length;
              return {
                dir,
                files: parsed.flatMap((file) =>
                  file.records === null ? [] : [{ path: file.path, records: file.records }],
                ),
                ...(failed > 0
                  ? {
                      status: "partial" as const,
                      message: `${failed} transcript paths could not be read.`,
                    }
                  : {}),
              } satisfies ProviderUsageScan;
            }),
          );
        }
        return sources.map((source) => ({ ...source, provider: reader.provider }));
      }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((sources) => sources.flat()),
      Effect.provideContext(context),
    );
});
