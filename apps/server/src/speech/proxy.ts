// @effect-diagnostics nodeBuiltinImport:off - The cold-start request needs an explicit HTTP deadline.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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

/** Preserve router PCM chunks, including sample boundaries split by HTTP transport. */
async function* streamRouterSpeech(
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
async function proxyRouterSpeech(
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
      body = JSON.stringify({ client: "t3-code", ttlSeconds: 120 });
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
      path = `/v1/audio/transcriptions/pcm?sample_rate=${rate}&language=en`;
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
    return { text: result.text };
  }
  throw new Error("Invalid speech response.");
}

type QueuedPresence = { id: string; expiresAt: string };
type QueuedClient = {
  beginConversation(options: {
    ttlSeconds: number;
    prepareTranscription: boolean;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<QueuedPresence>;
  renewConversation(id: string, options: { signal: AbortSignal }): Promise<QueuedPresence>;
  endConversation(id: string, options: { signal: AbortSignal }): Promise<unknown>;
  serviceStatus(options: {
    signal: AbortSignal;
  }): Promise<{ healthy: boolean; sessionOpen: boolean; warmEngines: string[] }>;
  transcribeWav(
    audio: Buffer,
    options: { language: string; signal: AbortSignal },
  ): Promise<{ text: string }>;
  submit(
    lines: { input: string; voice: string }[],
    options: { priority: "call"; signal: AbortSignal },
  ): Promise<{ id: string }[]>;
  stream(
    id: string,
    options: { signal: AbortSignal },
  ): Promise<{ sampleRate: number; chunks: ReadableStream<Uint8Array> }>;
  cancel(id: string, options: { signal: AbortSignal }): Promise<unknown>;
};

const queuedSpeechEnabled = () =>
  ["1", "true", "yes"].includes(process.env.OTIS_SPEECH_SERVICE_ENABLED?.toLowerCase() ?? "");

async function queuedClient(fetcher?: typeof fetch): Promise<QueuedClient> {
  const path = process.env.OTIS_SPEECH_CLIENT_MODULE;
  if (!path || !NodePath.isAbsolute(path) || !path.endsWith(".mjs"))
    throw new SpeechUnavailableError("Configure the published shared speech client module.");
  const module: unknown = await import(NodeURL.pathToFileURL(path).href);
  if (
    !module ||
    typeof module !== "object" ||
    !("createSpeechClient" in module) ||
    typeof module.createSpeechClient !== "function"
  )
    throw new SpeechUnavailableError("The shared speech client module is invalid.");
  const client: unknown = await module.createSpeechClient(fetcher ? { fetchImpl: fetcher } : {});
  const methods = [
    "beginConversation",
    "renewConversation",
    "endConversation",
    "serviceStatus",
    "transcribeWav",
    "submit",
    "stream",
    "cancel",
  ];
  if (
    !client ||
    typeof client !== "object" ||
    !methods.every((name) => name in client && typeof Reflect.get(client, name) === "function")
  )
    throw new SpeechUnavailableError(
      "The shared speech client lacks the required Call operations.",
    );
  return client as QueuedClient;
}

/** Stop waiting promptly while retaining the promise that owns any late resource. */
function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function cleanup(operation: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const signal = AbortSignal.timeout(2000);
  await untilAbort(
    Promise.resolve().then(() => operation(signal)),
    signal,
  ).catch(() => {});
}

async function servicePresence(
  client: QueuedClient,
  presence: QueuedPresence,
  signal: AbortSignal,
): Promise<SpeechResponse> {
  signal.throwIfAborted();
  const status = await untilAbort(client.serviceStatus({ signal }), signal);
  const tenants = [
    process.env.T3_CALL_STT_TENANT ?? "whisper-large-v3-turbo",
    process.env.T3_CALL_TTS_TENANT ?? "breeze-tts-2",
  ];
  if (
    status.healthy !== true ||
    status.sessionOpen !== true ||
    !Array.isArray(status.warmEngines) ||
    !status.warmEngines.every((id) => typeof id === "string") ||
    !tenants.every((id) => status.warmEngines.includes(id))
  )
    throw new SpeechUnavailableError("Speech engines are not ready. Prepare the call again.");
  if (!/^[a-f0-9-]{36}$/.test(presence.id) || !Number.isFinite(Date.parse(presence.expiresAt)))
    throw new SpeechUnavailableError("The service returned an invalid conversation presence.");
  return { sessionId: presence.id, expiresAt: presence.expiresAt, tenants: status.warmEngines };
}

async function acquireConversation(
  client: QueuedClient,
  signal: AbortSignal,
): Promise<SpeechResponse> {
  let abandoned = false;
  let presence: QueuedPresence | undefined;
  // Retain a late response so cancellation can end its caller-owned presence.
  const pending = client.beginConversation({
    ttlSeconds: 180,
    prepareTranscription: true,
    timeoutMs: CALL_PREPARE_TIMEOUT_MS,
    signal: AbortSignal.timeout(CALL_PREPARE_TIMEOUT_MS),
  });
  void pending
    .then((late) =>
      abandoned
        ? cleanup((cleanupSignal) => client.endConversation(late.id, { signal: cleanupSignal }))
        : undefined,
    )
    .catch(() => {});
  try {
    presence = await untilAbort(pending, signal);
    return await servicePresence(client, presence, signal);
  } catch (error) {
    abandoned = true;
    if (presence)
      await cleanup((cleanupSignal) =>
        client.endConversation(presence!.id, { signal: cleanupSignal }),
      );
    throw error;
  }
}

async function* streamQueuedSpeech(
  input: SpeechTransportRequest,
  signal: AbortSignal,
  client: QueuedClient,
): AsyncGenerator<SpeechResponse> {
  if (
    input.action !== "speak" ||
    !input.sessionId ||
    !/^[\w-]{1,128}$/.test(input.sessionId) ||
    !input.text?.trim() ||
    input.text.length > 1600
  )
    throw new Error("Invalid speech request.");
  signal.throwIfAborted();
  const points = Array.from(input.text);
  const lines = [];
  for (let offset = 0; offset < points.length;) {
    const limit = Math.min(offset + 1000, points.length);
    let end = limit;
    if (end < points.length) {
      while (end > offset && !/\s/.test(points[end - 1]!)) end--;
      if (end === offset) end = limit;
    }
    const text = points.slice(offset, end).join("").trim();
    if (text) lines.push({ input: text, voice: "otis" });
    offset = end;
  }
  let abandoned = false;
  const pendingJobs = new Set<string>();
  const pending = client.submit(lines, { priority: "call", signal: AbortSignal.timeout(90_000) });
  void pending
    .then(async (jobs) => {
      for (const job of jobs) pendingJobs.add(job.id);
      if (abandoned)
        await Promise.all(
          jobs.map((job) =>
            cleanup((cleanupSignal) => client.cancel(job.id, { signal: cleanupSignal })),
          ),
        );
    })
    .catch(() => {});
  let totalBytes = 0;
  try {
    const jobs = await untilAbort(pending, signal);
    for (const job of jobs) {
      signal.throwIfAborted();
      let streamAbandoned = false;
      const opening = client.stream(job.id, { signal });
      void opening
        .then((late) => (streamAbandoned ? cleanup(() => late.chunks.cancel()) : undefined))
        .catch(() => {});
      let opened: Awaited<ReturnType<QueuedClient["stream"]>>;
      try {
        opened = await untilAbort(opening, signal);
      } catch (error) {
        streamAbandoned = true;
        throw error;
      }
      const { sampleRate, chunks } = opened;
      if (!chunks || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
        await cleanup(() => chunks?.cancel() ?? Promise.resolve());
        throw new Error("Speech service returned an invalid stream.");
      }
      const reader = chunks.getReader();
      let carry = Buffer.alloc(0);
      let bytes = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const result = await untilAbort(reader.read(), signal);
          if (result.done) break;
          bytes += result.value.length;
          totalBytes += result.value.length;
          if (totalBytes > 24_000_000)
            throw new Error("Speech service returned too much PCM audio.");
          const chunk = Buffer.concat([carry, result.value]);
          const length = chunk.length & ~1;
          carry = chunk.subarray(length);
          if (length) yield { audio: chunk.subarray(0, length).toString("base64"), sampleRate };
        }
        if (!bytes || carry.length)
          throw new Error("Speech service returned incomplete PCM audio.");
        pendingJobs.delete(job.id);
      } finally {
        await cleanup(() => reader.cancel());
        reader.releaseLock();
      }
    }
  } finally {
    abandoned = true;
    await Promise.all(
      [...pendingJobs].map((id) =>
        cleanup((cleanupSignal) => client.cancel(id, { signal: cleanupSignal })),
      ),
    );
  }
}

export async function* streamSpeech(
  input: SpeechTransportRequest,
  signal: AbortSignal,
  fetcher?: typeof fetch,
  client?: QueuedClient,
): AsyncGenerator<SpeechResponse> {
  if (queuedSpeechEnabled())
    yield* streamQueuedSpeech(input, signal, client ?? (await queuedClient(fetcher)));
  else yield* streamRouterSpeech(input, signal, fetcher);
}

export async function proxySpeech(
  input: SpeechTransportRequest,
  signal: AbortSignal,
  fetcher?: typeof fetch,
  injectedClient?: QueuedClient,
): Promise<SpeechResponse> {
  if (!queuedSpeechEnabled()) return proxyRouterSpeech(input, signal, fetcher);
  signal.throwIfAborted();
  if (input.action !== "acquire" && (!input.sessionId || !/^[\w-]{1,128}$/.test(input.sessionId)))
    throw new Error("A speech session is required.");
  const client = injectedClient ?? (await queuedClient(fetcher));
  switch (input.action) {
    case "acquire":
      return acquireConversation(client, signal);
    case "renew":
      return servicePresence(
        client,
        await untilAbort(client.renewConversation(input.sessionId!, { signal }), signal),
        signal,
      );
    case "release":
      try {
        await untilAbort(client.endConversation(input.sessionId!, { signal }), signal);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "speech_conversation_not_found")
          throw error;
      }
      return {};
    case "transcribe": {
      const rate = input.sampleRate;
      if (!rate || !Number.isInteger(rate) || rate < 8000 || rate > 96000 || !input.audio)
        throw new Error("Invalid microphone recording.");
      const pcm = Buffer.from(input.audio, "base64");
      if (!pcm.length || pcm.length % 2 || pcm.length > rate * 2 * 60)
        throw new Error("Record up to one minute of speech.");
      const wav = microphoneWav(pcm, rate);
      const result = await untilAbort(
        client.transcribeWav(wav, { language: "en", signal }),
        signal,
      );
      if (typeof result.text !== "string") throw new Error("Invalid speech response.");
      return { text: result.text };
    }
    case "speak": {
      const audio: Buffer[] = [];
      let sampleRate: number | undefined;
      for await (const chunk of streamQueuedSpeech(input, signal, client)) {
        if (
          !chunk.audio ||
          !chunk.sampleRate ||
          (sampleRate !== undefined && sampleRate !== chunk.sampleRate)
        )
          throw new Error("Invalid speech sample rate.");
        sampleRate = chunk.sampleRate;
        audio.push(Buffer.from(chunk.audio, "base64"));
      }
      if (!sampleRate) throw new Error("Speech service returned invalid PCM audio.");
      return { audio: Buffer.concat(audio).toString("base64"), sampleRate };
    }
  }
}

/** Keep native browser capture rates while adapting to the service's 48 kHz WAV limit. */
function microphoneWav(pcm: Buffer, sourceRate: number): Buffer {
  const rate = Math.min(sourceRate, 48000);
  let audio = pcm;
  if (sourceRate > rate) {
    const samples = pcm.length / 2;
    const frames = Math.max(1, Math.round((samples * rate) / sourceRate));
    audio = Buffer.alloc(frames * 2);
    const width = samples / frames;
    for (let frame = 0; frame < frames; frame++) {
      const start = frame * width;
      const end = Math.min(samples, (frame + 1) * width);
      let sum = 0;
      for (let sample = Math.floor(start); sample < Math.ceil(end); sample++) {
        const weight = Math.min(end, sample + 1) - Math.max(start, sample);
        sum += pcm.readInt16LE(sample * 2) * weight;
      }
      audio.writeInt16LE(Math.round(sum / (end - start)), frame * 2);
    }
  }
  const wav = Buffer.alloc(44 + audio.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + audio.length, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(audio.length, 40);
  audio.copy(wav, 44);
  return wav;
}
