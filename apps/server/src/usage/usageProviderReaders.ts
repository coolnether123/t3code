import type { ProviderInstanceConfig, ServerSettings, UsageProviderKind } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type { ProviderUsageInstance, ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import * as ServerConfig from "../config.ts";
import { BUILT_IN_USAGE_DRIVERS, type BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import {
  listTranscriptFiles,
  readTranscriptRecords as readProviderTranscriptRecords,
  readDirectoryVolumeId,
} from "./usageProviderTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  type CachedFile,
} from "./usageProviderScanCache.ts";

// Codex and Claude retain the fork's bounded, resumable scanner and native attribution.
const readers = BUILT_IN_USAGE_DRIVERS.filter(
  (driver) => driver.usage !== undefined && !["codex", "claude"].includes(driver.usage.provider),
);

export const makeProviderUsageReader = Effect.gen(function* () {
  const hostEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const context = yield* Effect.context<BuiltInUsageReadersEnv>();
  const formats = new Map(
    BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
      driver.usage?.kind === "transcripts"
        ? [[driver.usage.provider, driver.usage.format] as const]
        : [],
    ),
  );
  const cachePath = path.join(config.stateDir, "usage-provider-scan-cache.json");
  const readCache = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.orElseSucceed(() => null),
    );
  let document = yield* readCache(cachePath);
  for (const name of [SCAN_CACHE_FILE_NAME, ...LEGACY_SCAN_CACHE_FILE_NAMES]) {
    if (document !== null) break;
    document = yield* readCache(path.join(config.stateDir, name));
  }
  const transcripts = decodeScanCache(document, formats);
  const decodeSources = Schema.decodeUnknownOption(
    Schema.Struct({
      sources: Schema.Record(
        Schema.String,
        Schema.Struct({ dir: Schema.String, volumeId: Schema.String }),
      ),
    }),
  );
  const previousSources = decodeSources(document);
  const sourceCache = new Map(
    Option.isSome(previousSources) ? Object.entries(previousSources.value.sources) : [],
  );
  const encodeCache = makeScanCacheWriter();
  let dirty = false;
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

  return Effect.fn("UsageService.readProviderUsage")(function* (input: {
    readonly settings: ServerSettings;
    readonly windowStartMs: number;
    readonly retentionCutoffMs: number;
    readonly awaitRefresh: boolean;
    readonly providers?: readonly UsageProviderKind[];
  }) {
    const result = yield* Effect.forEach(
      readers,
      Effect.fnUntraced(function* (driver) {
        const reader = driver.usage;
        if (
          reader === undefined ||
          (input.providers !== undefined && !input.providers.includes(reader.provider))
        )
          return [];
        const instances = yield* instancesFor(driver, input.settings);
        let sources: readonly (ProviderUsageScan & { readonly malformedRecords?: number })[];
        if (reader.kind === "scan") {
          sources = yield* reader.scan({ ...input, instances });
        } else {
          const directories = yield* Effect.forEach(
            (yield* Effect.forEach(instances, reader.directories)).flat(),
            (directory) =>
              fileSystem.realPath(directory.dir).pipe(
                Effect.orElseSucceed(
                  () =>
                    sourceCache.get(`${reader.provider}\0${directory.dir}`)?.dir ?? directory.dir,
                ),
                Effect.map((dir) => {
                  const sourceKey = `${reader.provider}\0${directory.dir}`;
                  const previous = sourceCache.get(sourceKey);
                  if (dir !== directory.dir && previous?.dir !== dir) {
                    sourceCache.set(sourceKey, { dir, volumeId: previous?.volumeId ?? "" });
                    dirty = true;
                  }
                  return { ...directory, dir };
                }),
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
              const exists = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
              const sourceKey = `${reader.provider}\0${dir}`;
              const previousSource = sourceCache.get(sourceKey);
              const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
              const volumeId = previousSource?.volumeId || currentVolumeId;
              if (previousSource?.dir !== dir || previousSource.volumeId !== volumeId) {
                sourceCache.set(sourceKey, { dir, volumeId });
                dirty = true;
              }
              const retained = [...transcripts].filter(([filePath, file]) => {
                const relative = path.relative(dir, filePath);
                return (
                  file.provider === reader.provider &&
                  file.mtimeMs >= input.windowStartMs &&
                  relative !== ".." &&
                  !relative.startsWith(".." + path.sep) &&
                  !path.isAbsolute(relative)
                );
              });
              if (!exists && retained.length === 0) return { dir, volumeId, files: null };
              const listing = exists
                ? yield* Effect.promise(() =>
                    listTranscriptFiles(
                      dir,
                      input.windowStartMs,
                      fileName === undefined ? undefined : { fileName },
                    ),
                  )
                : { files: [], failedPaths: 0 };
              const files = [
                ...new Map([
                  ...retained.map(
                    ([filePath, entry]) =>
                      [
                        filePath,
                        { path: filePath, size: entry.size, mtimeMs: entry.mtimeMs },
                      ] as const,
                  ),
                  ...listing.files.map((file) => [file.path, file] as const),
                ]).values(),
              ];
              const parsed = yield* Effect.forEach(
                files,
                (file) =>
                  Effect.promise(async () => ({
                    path: file.path,
                    parsed: await (async () => {
                      const cached = transcripts.get(file.path);
                      if (
                        cached?.provider === reader.provider &&
                        cached.size === file.size &&
                        cached.mtimeMs === file.mtimeMs
                      )
                        return cached;
                      const parsed = await readProviderTranscriptRecords(
                        file.path,
                        reader.format,
                        cached?.provider === reader.provider && file.size > cached.size
                          ? cached.position
                          : undefined,
                      );
                      if (parsed === null)
                        return cached?.provider !== reader.provider
                          ? null
                          : { ...cached, failed: true };
                      const records =
                        parsed.resumed && cached !== undefined
                          ? [...cached.records, ...parsed.records]
                          : parsed.records;
                      const seen = new Set<string>();
                      const entry: CachedFile = {
                        size: file.size,
                        mtimeMs: file.mtimeMs,
                        provider: reader.provider,
                        records: dedupeWithinFile(records, seen),
                        tailRecords: dedupeWithinFile(parsed.tailRecords, seen),
                        malformedRecords: parsed.malformedRecords,
                        position: parsed.position,
                      };
                      transcripts.set(file.path, entry);
                      dirty = true;
                      return entry;
                    })(),
                  })),
                { concurrency: 4 },
              );
              const failed =
                listing.failedPaths +
                parsed.filter((file) => file.parsed === null || "failed" in file.parsed).length;
              const malformedRecords = parsed.reduce(
                (sum, file) => sum + (file.parsed?.malformedRecords ?? 0),
                0,
              );
              return {
                dir,
                volumeId,
                malformedRecords,
                files: parsed.flatMap((file) =>
                  file.parsed === null
                    ? []
                    : [
                        {
                          path: file.path,
                          records: [...file.parsed.records, ...file.parsed.tailRecords],
                        },
                      ],
                ),
                ...(!exists || failed > 0 || malformedRecords > 0
                  ? {
                      status: "partial" as const,
                      message: !exists
                        ? "Transcript directory is unavailable; retained cached usage is included."
                        : `${failed} unreadable transcript paths; ${malformedRecords} malformed or inconsistent usage records.`,
                    }
                  : {}),
              } satisfies ProviderUsageScan & { readonly malformedRecords: number };
            }),
          );
        }
        return sources.map((source) => ({
          ...source,
          provider: reader.provider,
          malformedRecords:
            "malformedRecords" in source && typeof source.malformedRecords === "number"
              ? source.malformedRecords
              : 0,
        }));
      }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((sources) => sources.flat()),
      Effect.provideContext(context),
    );
    if (pruneScanCache(transcripts, input.retentionCutoffMs) > 0) dirty = true;
    if (dirty) {
      yield* writeFileStringAtomically({
        filePath: cachePath,
        contents: encodeCache(transcripts, { sources: Object.fromEntries(sourceCache) }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tap(() =>
          Effect.sync(() => {
            dirty = false;
          }),
        ),
        Effect.ignore,
      );
    }
    return result;
  });
});
