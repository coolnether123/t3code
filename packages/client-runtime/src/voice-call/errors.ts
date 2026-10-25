/** Errors from the speech endpoint carry their retry policy across client surfaces. */
export class VoiceRequestError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super(message);
    this.recoverable = recoverable;
  }
}

export function isRetryableVoiceError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null) return false;
  if ("recoverable" in error) return error.recoverable === true;
  return (
    "_tag" in error &&
    (error._tag === "RemoteEnvironmentAuthFetchError" ||
      error._tag === "RemoteEnvironmentAuthTimeoutError")
  );
}

/** Preserve a speech error's policy through the environment HTTP wrappers. */
export function voiceRequestError(error: unknown): VoiceRequestError {
  let cause = error;
  const seen = new Set<unknown>();
  while (typeof cause === "object" && cause !== null && !seen.has(cause)) {
    if (cause instanceof VoiceRequestError) return cause;
    seen.add(cause);
    if (
      !("_tag" in cause) ||
      cause._tag !== "RemoteEnvironmentAuthFetchError" ||
      !("cause" in cause)
    )
      break;
    cause = cause.cause;
  }
  return new VoiceRequestError(
    error instanceof Error ? error.message : "Voice request failed.",
    isRetryableVoiceError(error),
  );
}
