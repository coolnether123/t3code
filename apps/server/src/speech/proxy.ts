// @effect-diagnostics nodeBuiltinImport:off - The cold-start request needs an explicit HTTP deadline.
import * as NodeHttp from "node:http";
import {
  CALL_PREPARE_TIMEOUT_MS,
  type SpeechTransportRequest,
  type SpeechResponse,
} from "@t3tools/contracts";

/** Node fetch has a shorter headers deadline than the router's cold-start budget. */
const acquireSpeechLease = (url: string, init: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      url,
      {
        method: init.method,
        headers: { "content-type": "application/json" },
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode! })),
        );
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });

export class SpeechUnavailableError extends Error {}

/** An absent or unhealthy recognizer must never be started as a readiness probe. */
export async function speechInputMode(
  signal: AbortSignal,
  sttTenant: string,
  forceDevice = false,
  fetcher: typeof fetch = fetch,
): Promise<"pc" | "device"> {
  if (forceDevice) return "device";
  try {
    const response = await fetcher("http://127.0.0.1:8085/health", {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    const snapshot: unknown = await response.json();
    const speech =
      snapshot && typeof snapshot === "object" && "speech" in snapshot
        ? snapshot.speech
        : undefined;
    const tenants =
      speech && typeof speech === "object" && "tenants" in speech ? speech.tenants : undefined;
    return response.ok &&
      Array.isArray(tenants) &&
      tenants.some(
        (tenant: unknown) =>
          tenant &&
          typeof tenant === "object" &&
          "id" in tenant &&
          tenant.id === sttTenant &&
          "running" in tenant &&
          tenant.running === true &&
          "healthy" in tenant &&
          tenant.healthy === true,
      )
      ? "pc"
      : "device";
  } catch {
    signal.throwIfAborted();
    return "device";
  }
}

/** Preserve router PCM chunks, including sample boundaries split by HTTP transport. */
export async function* streamSpeech(
  input: SpeechTransportRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): AsyncGenerator<SpeechResponse> {
  if (
    input.action !== "speak" ||
    !input.sessionId ||
    !/^[\w-]{1,128}$/.test(input.sessionId) ||
    !input.text?.trim() ||
    input.text.length > 1600
  )
    throw new Error("Invalid speech request.");
  const response = await fetcher("http://127.0.0.1:8085/v1/audio/speech", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    headers: { "content-type": "application/json", "X-Voice-Session-Id": input.sessionId },
    body: JSON.stringify({
      model: input.model ?? "breeze-tts-2",
      input: input.text,
      voice: "otis",
      response_format: "pcm",
      stream: true,
    }),
  });
  if (!response.ok)
    throw new SpeechUnavailableError(`Local speech service unavailable (${response.status}).`);
  const sampleRate = Number(response.headers.get("x-sample-rate"));
  if (!response.body || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
    throw new Error("Speech service returned an invalid stream.");
  const reader = response.body.getReader();
  let carry = Buffer.alloc(0);
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.concat([carry, result.value]);
      bytes += result.value.length;
      if (bytes > 24_000_000) throw new Error("Speech service returned too much PCM audio.");
      const length = chunk.length & ~1;
      carry = chunk.subarray(length);
      if (length) yield { audio: chunk.subarray(0, length).toString("base64"), sampleRate };
    }
    if (!bytes || carry.length) throw new Error("Speech service returned incomplete PCM audio.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed loopback destination: microphone audio never follows client-supplied URLs. */
export async function proxySpeech(
  input: SpeechTransportRequest,
  signal: AbortSignal,
  fetcher?: typeof fetch,
): Promise<SpeechResponse> {
  const sessionId = input.sessionId;
  if (input.action !== "acquire" && (!sessionId || !/^[\w-]{1,128}$/.test(sessionId))) {
    throw new Error("A speech session is required.");
  }
  let path: string;
  let method = "POST";
  let body: string | Uint8Array | undefined;
  let contentType = "application/json";
  switch (input.action) {
    case "acquire":
      path = "/v1/voice/sessions";
      body = JSON.stringify({
        client: "t3-code",
        ttlSeconds: 120,
        ...(input.tenants ? { tenants: input.tenants } : {}),
      });
      break;
    case "renew":
      path = `/v1/voice/sessions/${sessionId}/renew`;
      body = JSON.stringify({ ttlSeconds: 120 });
      break;
    case "release":
      path = `/v1/voice/sessions/${sessionId}`;
      method = "DELETE";
      break;
    case "transcribe": {
      const rate = input.sampleRate;
      if (!rate || !Number.isInteger(rate) || rate < 8000 || rate > 96000 || !input.audio) {
        throw new Error("Invalid microphone recording.");
      }
      body = Buffer.from(input.audio, "base64");
      if (body.length === 0 || body.length % 2 !== 0 || body.length > rate * 2 * 60) {
        throw new Error("Record up to one minute of speech.");
      }
      path = `/v1/audio/transcriptions/pcm?sample_rate=${rate}&language=en${input.revision ? `&revision=${input.revision}` : ""}`;
      contentType = "application/octet-stream";
      break;
    }
    case "speak":
      if (!input.text?.trim() || input.text.length > 1600) {
        throw new Error("Invalid speech text.");
      }
      path = "/v1/audio/speech";
      body = JSON.stringify({
        model: input.model ?? "breeze-tts-2",
        input: input.text,
        voice: "otis",
        response_format: "pcm",
        stream: true,
      });
      break;
  }
  const request = fetcher ?? (input.action === "acquire" ? acquireSpeechLease : fetch);
  const response = await request(`http://127.0.0.1:8085${path}`, {
    method,
    headers: {
      "content-type": contentType,
      ...(sessionId ? { "X-Voice-Session-Id": sessionId } : {}),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : new Uint8Array(body) }),
    redirect: "error",
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(input.action === "acquire" ? CALL_PREPARE_TIMEOUT_MS : 90_000),
    ]),
  });
  if (input.action === "release" && response.status === 404) return {};
  if (!response.ok)
    throw new SpeechUnavailableError(`Local speech service unavailable (${response.status}).`);
  if (input.action === "release") return {};
  if (input.action === "speak") {
    const sampleRate = Number(response.headers.get("x-sample-rate"));
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
      throw new Error("Speech service returned an invalid sample rate.");
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length % 2 !== 0 || audio.length > 24_000_000) {
      throw new Error("Speech service returned invalid PCM audio.");
    }
    return { audio: audio.toString("base64"), sampleRate };
  }
  const result: unknown = await response.json();
  if (typeof result !== "object" || result === null) throw new Error("Invalid speech response.");
  if (
    (input.action === "acquire" || input.action === "renew") &&
    "sessionId" in result &&
    typeof result.sessionId === "string" &&
    /^[\w-]{1,128}$/.test(result.sessionId)
  ) {
    if (input.action === "renew") {
      const health = await (fetcher ?? fetch)("http://127.0.0.1:8085/health", {
        signal,
        redirect: "error",
      });
      const snapshot: unknown = await health.json();
      const speech =
        snapshot && typeof snapshot === "object" && "speech" in snapshot
          ? snapshot.speech
          : undefined;
      const tenants =
        speech && typeof speech === "object" && "tenants" in speech ? speech.tenants : undefined;
      if (
        !health.ok ||
        !Array.isArray(tenants) ||
        !("tenants" in result) ||
        !Array.isArray(result.tenants) ||
        !result.tenants.length ||
        !result.tenants.every((id: unknown) =>
          tenants.some(
            (tenant: unknown) =>
              tenant &&
              typeof tenant === "object" &&
              "id" in tenant &&
              tenant.id === id &&
              "healthy" in tenant &&
              tenant.healthy === true &&
              "running" in tenant &&
              tenant.running === true,
          ),
        )
      )
        throw new SpeechUnavailableError("Speech engine health was lost. Prepare the call again.");
    }
    return {
      sessionId: result.sessionId,
      ...("expiresAt" in result && typeof result.expiresAt === "string"
        ? { expiresAt: result.expiresAt }
        : {}),
      ...("tenants" in result &&
      Array.isArray(result.tenants) &&
      result.tenants.every((id) => typeof id === "string")
        ? { tenants: result.tenants as string[] }
        : {}),
    };
  }
  if (input.action === "transcribe" && "text" in result && typeof result.text === "string") {
    return {
      text: result.text,
      ...(input.revision
        ? { revision: input.revision, transcriptFinal: "final" in result && result.final === true }
        : {}),
    };
  }
  throw new Error("Invalid speech response.");
}
