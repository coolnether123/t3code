import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";

const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** A parent-owned passing receipt admits cutover. No subscriber deletes legacy data. */
export function validPromptCutoverReceipt(receipt: unknown): boolean {
  if (typeof receipt !== "object" || receipt === null) return false;
  const proof = receipt as Record<string, unknown>;
  return (
    proof.schemaVersion === 1 &&
    proof.reportContractVersion === 1 &&
    proof.countingPolicy === "unicode-runs-nfkc-v1" &&
    proof.matched === true &&
    proof.sourceDrift === false &&
    Array.isArray(proof.windows) &&
    proof.windows.length > 0 &&
    proof.windows.every(
      (window: unknown) =>
        typeof window === "object" &&
        window !== null &&
        "matched" in window &&
        window.matched === true,
    )
  );
}

export const promptCutoverEnabled = (
  env: NodeJS.ProcessEnv = process.env,
  filesystem?: FileSystem.FileSystem,
) =>
  Effect.gen(function* () {
    if (
      env.T3_OTIS_USAGE_MODE !== "otis" ||
      !env.T3_OTIS_USAGE_ORIGIN ||
      !env.T3_OTIS_USAGE_TOKEN ||
      !env.T3_OTIS_USAGE_PARITY_RECEIPT
    )
      return false;
    const available = yield* Effect.serviceOption(FileSystem.FileSystem);
    const fs = filesystem ?? Option.getOrUndefined(available);
    if (!fs) return false;
    const stat = yield* fs.stat(env.T3_OTIS_USAGE_PARITY_RECEIPT);
    if (stat.size > 4n * 1024n * 1024n) return false;
    const text = yield* fs.readFileString(env.T3_OTIS_USAGE_PARITY_RECEIPT);
    return validPromptCutoverReceipt(yield* decodeReceipt(text));
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));

let localFallbackUntil = 0;
let promptIndexCutover = false;
export function setPromptIndexCutover(enabled: boolean): void {
  promptIndexCutover = enabled;
}
export function promptIndexCutoverEnabled(): boolean {
  return promptIndexCutover;
}
export const requestLocalPromptIndex = Effect.map(Clock.currentTimeMillis, (now) => {
  localFallbackUntil = now + 60_000;
});
export const localPromptFallbackActive = Effect.map(
  Clock.currentTimeMillis,
  (now) => now < localFallbackUntil,
);
