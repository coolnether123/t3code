// @effect-diagnostics nodeBuiltinImport:off - Mock the Node HTTP boundary used for cold acquisition.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import { proxySpeech, streamSpeech } from "./proxy.ts";

vi.mock("node:http", () => ({ request: vi.fn() }));

describe("local speech proxy", () => {
  beforeEach(() => vi.stubEnv("OTIS_SPEECH_SERVICE_ENABLED", "0"));
  afterEach(() => vi.unstubAllEnvs());
  it("keeps the unaccepted default on the legacy route when the switch is absent", async () => {
    vi.stubEnv("OTIS_SPEECH_SERVICE_ENABLED", undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sessionId: "legacy" }));
    expect(await proxySpeech({ action: "acquire" }, new AbortController().signal, fetcher)).toEqual(
      { sessionId: "legacy" },
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8085/v1/voice/sessions");
  });
  it("returns the first aligned PCM chunk before synthesis finishes and cancels on consumer exit", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel: cancelled,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { headers: { "x-sample-rate": "24000" } }));
    const audio = streamSpeech(
      { action: "speak", sessionId: "lease", text: "First sentence." },
      new AbortController().signal,
      fetcher,
    );
    const first = audio.next();
    source.enqueue(new Uint8Array([1, 0, 2]));
    expect((await first).value).toEqual({ audio: "AQA=", sampleRate: 24000 });
    source.enqueue(new Uint8Array([0]));
    expect((await audio.next()).value).toEqual({ audio: "AgA=", sampleRate: 24000 });
    await audio.return(undefined);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("rejects a stream ending with a partial PCM sample", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { headers: { "x-sample-rate": "24000" } }),
      );
    const audio = streamSpeech(
      { action: "speak", sessionId: "lease", text: "First." },
      new AbortController().signal,
      fetcher,
    );
    await expect(audio.next()).rejects.toThrow("incomplete PCM");
  });
  it("uses Node HTTP for acquisition without fetch's five-minute headers deadline", async () => {
    const response = Object.assign(new NodeStream.PassThrough(), { statusCode: 200 });
    const request = Object.assign(new NodeEvents.EventEmitter(), {
      end: vi.fn((_body: unknown) => response.end(JSON.stringify({ sessionId: "cold" }))),
    });
    vi.mocked(NodeHttp.request).mockImplementation((_url, _options, receive) => {
      receive!(response as unknown as NodeHttp.IncomingMessage);
      return request as unknown as NodeHttp.ClientRequest;
    });
    expect(await proxySpeech({ action: "acquire" }, new AbortController().signal)).toEqual({
      sessionId: "cold",
    });
    expect(NodeHttp.request).toHaveBeenCalledWith(
      "http://127.0.0.1:8085/v1/voice/sessions",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
    expect(JSON.parse(String(request.end.mock.calls[0]?.[0]))).toEqual({
      client: "t3-code",
      ttlSeconds: 120,
    });
  });
  it("keeps acquisition connected past five minutes until the router finishes", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      // @effect-diagnostics-next-line globalTimers:off - Exercise native AbortSignal deadlines with Vitest's fake clock.
      setTimeout(() => controller.abort(new Error("timeout")), ms);
      return controller.signal;
    });
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((resolve, reject) => {
          complete = resolve;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    try {
      const acquiring = proxySpeech({ action: "acquire" }, new AbortController().signal, fetcher);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      complete(Response.json({ sessionId: "cold" }));
      expect(await acquiring).toEqual({ sessionId: "cold" });
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
  it("retains router expiry and verifies tenant health when renewing", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          sessionId: "lease",
          expiresAt: "2099-01-01T00:00:00Z",
          tenants: ["stt", "tts"],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          speech: {
            tenants: [
              { id: "stt", healthy: true, running: true },
              { id: "tts", healthy: true, running: true },
            ],
          },
        }),
      );
    expect(
      await proxySpeech(
        { action: "renew", sessionId: "lease" },
        new AbortController().signal,
        fetcher,
      ),
    ).toMatchObject({ expiresAt: "2099-01-01T00:00:00Z" });
    expect(fetcher.mock.calls[1]?.[0]).toBe("http://127.0.0.1:8085/health");
  });
  it("refuses renewal readiness when a speech tenant is unhealthy", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ sessionId: "lease", expiresAt: "2099-01-01T00:00:00Z", tenants: ["stt"] }),
      )
      .mockResolvedValueOnce(
        Response.json({ speech: { tenants: [{ id: "stt", healthy: false, running: true }] } }),
      );
    await expect(
      proxySpeech({ action: "renew", sessionId: "lease" }, new AbortController().signal, fetcher),
    ).rejects.toThrow("health was lost");
  });
  it("releases expired leases idempotently", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      proxySpeech(
        { action: "release", sessionId: "expired" },
        new AbortController().signal,
        fetcher,
      ),
    ).resolves.toEqual({});
  });
  const signal = new AbortController().signal;
  it("acquires only a local GPU lease, without opening an AI conversation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ sessionId: "lease-1" }));
    await expect(proxySpeech({ action: "acquire" }, signal, fetcher)).resolves.toEqual({
      sessionId: "lease-1",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8085/v1/voice/sessions");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      client: "t3-code",
      ttlSeconds: 120,
    });
  });
  it("forwards PCM to local STT and returns text", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ text: "Hello", durationMs: 1 }));
    await expect(
      proxySpeech(
        { action: "transcribe", sessionId: "lease", audio: "AAA=", sampleRate: 16000 },
        signal,
        fetcher,
      ),
    ).resolves.toEqual({ text: "Hello" });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8085/v1/audio/transcriptions/pcm?sample_rate=16000&language=en",
    );
  });
  it("returns raw speech PCM with the declared sample rate", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array([0, 0]), { headers: { "X-Sample-Rate": "24000" } }),
      );
    await expect(
      proxySpeech({ action: "speak", sessionId: "lease", text: "Done." }, signal, fetcher),
    ).resolves.toEqual({ audio: "AAA=", sampleRate: 24000 });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: true });
  });
  it("rejects missing leases and invalid recording parameters before contacting speech services", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(proxySpeech({ action: "speak", text: "hi" }, signal, fetcher)).rejects.toThrow(
      "session",
    );
    await expect(
      proxySpeech(
        { action: "transcribe", sessionId: "../bad", sampleRate: 16000, audio: "AAA=" },
        signal,
        fetcher,
      ),
    ).rejects.toThrow("session");
    await expect(
      proxySpeech(
        { action: "transcribe", sessionId: "lease", sampleRate: 0, audio: "AAA=" },
        signal,
        fetcher,
      ),
    ).rejects.toThrow("Invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports local service failure without falling back to an external recognizer", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 409 }));
    await expect(proxySpeech({ action: "acquire" }, signal, fetcher)).rejects.toThrow("409");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

type TestQueuedClient = NonNullable<Parameters<typeof proxySpeech>[3]>;
const presenceId = "11111111-1111-4111-8111-111111111111";
const ownedJob = "22222222-2222-4222-8222-222222222222";
const secondJob = "33333333-3333-4333-8333-333333333333";

function queuedFixture() {
  const presence = { id: presenceId, expiresAt: "2099-01-01T00:00:00Z" };
  return {
    beginConversation: vi.fn<TestQueuedClient["beginConversation"]>(async () => presence),
    renewConversation: vi.fn<TestQueuedClient["renewConversation"]>(async () => presence),
    endConversation: vi.fn<TestQueuedClient["endConversation"]>(async () => ({ ended: true })),
    serviceStatus: vi.fn<TestQueuedClient["serviceStatus"]>(async () => ({
      healthy: true,
      sessionOpen: true,
      warmEngines: ["whisper-large-v3-turbo", "breeze-tts-2"],
    })),
    transcribeWav: vi.fn<TestQueuedClient["transcribeWav"]>(async () => ({
      text: "Recognized locally.",
    })),
    submit: vi.fn<TestQueuedClient["submit"]>(async () => [{ id: ownedJob }]),
    stream: vi.fn<TestQueuedClient["stream"]>(async () => ({
      sampleRate: 24000,
      chunks: new Response(new Uint8Array([1, 0])).body!,
    })),
    cancel: vi.fn<TestQueuedClient["cancel"]>(async () => ({})),
  };
}

describe("queued Call speech proxy", () => {
  beforeEach(() => {
    vi.stubEnv("OTIS_SPEECH_SERVICE_ENABLED", "1");
    vi.stubEnv("T3_CALL_STT_TENANT", "whisper-large-v3-turbo");
    vi.stubEnv("T3_CALL_TTS_TENANT", "breeze-tts-2");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("fails closed when the shared client module is not configured", async () => {
    vi.stubEnv("OTIS_SPEECH_CLIENT_MODULE", "relative-client.mjs");
    const noRouter = vi.fn<typeof fetch>();
    await expect(
      proxySpeech({ action: "acquire" }, new AbortController().signal, noRouter),
    ).rejects.toThrow("published shared speech client");
    expect(noRouter).not.toHaveBeenCalled();
  });

  it("maps verified service presence and renewals to the existing Call contract", async () => {
    const client = queuedFixture();
    const noRouter = vi.fn<typeof fetch>();
    const signal = new AbortController().signal;
    const expected = {
      sessionId: presenceId,
      expiresAt: "2099-01-01T00:00:00Z",
      tenants: ["whisper-large-v3-turbo", "breeze-tts-2"],
    };
    expect(await proxySpeech({ action: "acquire" }, signal, noRouter, client)).toEqual(expected);
    expect(client.beginConversation.mock.calls[0]?.[0]).toMatchObject({
      ttlSeconds: 180,
      prepareTranscription: true,
    });
    expect(client.beginConversation.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(300_000);
    expect(
      await proxySpeech({ action: "renew", sessionId: presenceId }, signal, noRouter, client),
    ).toEqual(expected);
    expect(client.renewConversation).toHaveBeenCalledWith(presenceId, { signal });
    expect(client.serviceStatus).toHaveBeenCalledTimes(2);
    expect(noRouter).not.toHaveBeenCalled();
    await proxySpeech({ action: "release", sessionId: presenceId }, signal, noRouter, client);
    expect(client.endConversation).toHaveBeenCalledWith(presenceId, { signal });
  });

  it("ends acquisition when service health cannot establish readiness", async () => {
    const client = queuedFixture();
    client.serviceStatus.mockResolvedValue({
      healthy: false,
      sessionOpen: true,
      warmEngines: ["whisper-large-v3-turbo", "breeze-tts-2"],
    });
    await expect(
      proxySpeech({ action: "acquire" }, new AbortController().signal, undefined, client),
    ).rejects.toThrow("not ready");
    expect(client.endConversation).toHaveBeenCalledOnce();
    expect(client.endConversation.mock.calls[0]?.[0]).toBe(presenceId);
  });

  it("does not invent a missing configured tenant", async () => {
    const client = queuedFixture();
    vi.stubEnv("T3_CALL_STT_TENANT", "another-stt");
    await expect(
      proxySpeech({ action: "acquire" }, new AbortController().signal, undefined, client),
    ).rejects.toThrow("not ready");
    expect(client.endConversation).toHaveBeenCalledOnce();
  });

  it("returns promptly on cancelled acquisition and ends its late presence", async () => {
    const client = queuedFixture();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<TestQueuedClient["beginConversation"]>>>();
    const ended = Promise.withResolvers<void>();
    client.beginConversation.mockReturnValue(pending.promise);
    client.endConversation.mockImplementation(async () => {
      ended.resolve();
      return { ended: true };
    });
    const controller = new AbortController();
    const operation = proxySpeech({ action: "acquire" }, controller.signal, undefined, client);
    controller.abort(new Error("Caller left"));
    await expect(operation).rejects.toThrow("Caller left");
    pending.resolve({ id: presenceId, expiresAt: "2099-01-01T00:00:00Z" });
    await ended.promise;
    expect(client.endConversation.mock.calls[0]?.[0]).toBe(presenceId);
    expect(client.endConversation.mock.calls[0]?.[1].signal).not.toBe(controller.signal);
    expect(client.serviceStatus).not.toHaveBeenCalled();
  });

  it("wraps phone PCM as mono WAV and keeps recognition local to the service", async () => {
    const client = queuedFixture();
    const noRouter = vi.fn<typeof fetch>();
    const signal = new AbortController().signal;
    expect(
      await proxySpeech(
        { action: "transcribe", sessionId: presenceId, audio: "AQACAAMA", sampleRate: 16000 },
        signal,
        noRouter,
        client,
      ),
    ).toEqual({ text: "Recognized locally." });
    const wav = client.transcribeWav.mock.calls[0]![0];
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44)).toEqual(Buffer.from("AQACAAMA", "base64"));
    expect(client.transcribeWav.mock.calls[0]![1]).toEqual({ language: "en", signal });
    expect(noRouter).not.toHaveBeenCalled();
  });

  it("preserves duration when a phone records at 96 kHz above the service WAV limit", async () => {
    const client = queuedFixture();
    const pcm = Buffer.alloc(8);
    [1000, 3000, -1000, -3000].forEach((value, index) => pcm.writeInt16LE(value, index * 2));
    await proxySpeech(
      {
        action: "transcribe",
        sessionId: presenceId,
        audio: pcm.toString("base64"),
        sampleRate: 96000,
      },
      new AbortController().signal,
      undefined,
      client,
    );
    const wav = client.transcribeWav.mock.calls[0]![0];
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24)).toBe(pcm.length / 2 / 96000);
    expect(wav.readInt16LE(44)).toBe(2000);
    expect(wav.readInt16LE(46)).toBe(-2000);
  });

  it("streams aligned PCM before EOF and cancels only its unfinished jobs on exit", async () => {
    const client = queuedFixture();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const closed = vi.fn();
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel: closed,
    });
    client.stream.mockResolvedValue({ sampleRate: 24000, chunks });
    const audio = streamSpeech(
      { action: "speak", sessionId: presenceId, text: "First sentence." },
      new AbortController().signal,
      undefined,
      client,
    );
    const first = audio.next();
    source.enqueue(new Uint8Array([1, 0, 2]));
    expect((await first).value).toEqual({ audio: "AQA=", sampleRate: 24000 });
    source.enqueue(new Uint8Array([0]));
    expect((await audio.next()).value).toEqual({ audio: "AgA=", sampleRate: 24000 });
    await audio.return(undefined);
    expect(client.submit.mock.calls[0]![1].priority).toBe("call");
    expect(client.cancel).toHaveBeenCalledOnce();
    expect(client.cancel.mock.calls[0]![0]).toBe(ownedJob);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("keeps completed audio and does not DELETE a fully consumed job", async () => {
    const client = queuedFixture();
    const received = [];
    for await (const chunk of streamSpeech(
      { action: "speak", sessionId: presenceId, text: "Done." },
      new AbortController().signal,
      undefined,
      client,
    ))
      received.push(chunk);
    expect(received).toEqual([{ audio: "AQA=", sampleRate: 24000 }]);
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("bounds cleanup even when a transport ignores its cancellation signal", async () => {
    const client = queuedFixture();
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => (ms === 2000 ? deadline.signal : originalTimeout(ms)));
    const cancelling = Promise.withResolvers<void>();
    client.cancel.mockImplementation(() => {
      cancelling.resolve();
      return new Promise(() => {});
    });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    client.stream.mockResolvedValue({
      sampleRate: 24000,
      chunks: new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
    });
    const controller = new AbortController();
    const audio = streamSpeech(
      { action: "speak", sessionId: presenceId, text: "Stop." },
      controller.signal,
      undefined,
      client,
    );
    try {
      const first = audio.next();
      source.enqueue(new Uint8Array([1, 0]));
      await first;
      const closing = audio.return(undefined);
      await cancelling.promise;
      deadline.abort(new Error("Cleanup deadline"));
      await closing;
      expect(controller.signal.aborted).toBe(false);
    } finally {
      timeout.mockRestore();
    }
  });

  it("cancels a job returned after its submit awaiter was aborted", async () => {
    const client = queuedFixture();
    const pending = Promise.withResolvers<{ id: string }[]>();
    const submitted = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    client.submit.mockImplementation(() => {
      submitted.resolve();
      return pending.promise;
    });
    client.cancel.mockImplementation(async () => {
      cancelled.resolve();
      return {};
    });
    const controller = new AbortController();
    const audio = streamSpeech(
      { action: "speak", sessionId: presenceId, text: "Cancel." },
      controller.signal,
      undefined,
      client,
    );
    const first = audio.next();
    await submitted.promise;
    controller.abort(new Error("Barge in"));
    await expect(first).rejects.toThrow("Barge in");
    pending.resolve([{ id: ownedJob }]);
    await cancelled.promise;
    expect(client.cancel.mock.calls[0]![0]).toBe(ownedJob);
    expect(client.cancel.mock.calls[0]![1].signal).not.toBe(controller.signal);
    expect(client.stream).not.toHaveBeenCalled();
  });

  it("closes a late stream response and cancels the abandoned job", async () => {
    const client = queuedFixture();
    const pending = Promise.withResolvers<Awaited<ReturnType<TestQueuedClient["stream"]>>>();
    const opening = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    client.stream.mockImplementation(() => {
      opening.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const audio = streamSpeech(
      { action: "speak", sessionId: presenceId, text: "Late." },
      controller.signal,
      undefined,
      client,
    );
    const first = audio.next();
    await opening.promise;
    controller.abort(new Error("Barge in"));
    await expect(first).rejects.toThrow("Barge in");
    pending.resolve({
      sampleRate: 24000,
      chunks: new ReadableStream({
        cancel() {
          closed.resolve();
        },
      }),
    });
    await closed.promise;
    expect(client.cancel.mock.calls[0]![0]).toBe(ownedJob);
  });

  it("keeps the 1600-character Call contract within 1000-codepoint service lines", async () => {
    const client = queuedFixture();
    client.submit.mockResolvedValue([{ id: ownedJob }, { id: secondJob }]);
    const result = await proxySpeech(
      { action: "speak", sessionId: presenceId, text: "x".repeat(1500) },
      new AbortController().signal,
      undefined,
      client,
    );
    expect(client.submit.mock.calls[0]![0].map((line) => line.input.length)).toEqual([1000, 500]);
    expect(result).toEqual({ audio: "AQABAA==", sampleRate: 24000 });
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("rejects partial PCM and cancels its job", async () => {
    const client = queuedFixture();
    client.stream.mockResolvedValue({
      sampleRate: 24000,
      chunks: new Response(new Uint8Array([1])).body!,
    });
    const audio = streamSpeech(
      { action: "speak", sessionId: presenceId, text: "Partial." },
      new AbortController().signal,
      undefined,
      client,
    );
    await expect(audio.next()).rejects.toThrow("incomplete PCM");
    expect(client.cancel.mock.calls[0]![0]).toBe(ownedJob);
  });

  it("rejects invalid phone data before submitting service work", async () => {
    const client = queuedFixture();
    const signal = new AbortController().signal;
    await expect(
      proxySpeech(
        { action: "transcribe", sessionId: presenceId, audio: "AQ==", sampleRate: 16000 },
        signal,
        undefined,
        client,
      ),
    ).rejects.toThrow("one minute");
    await expect(
      proxySpeech({ action: "speak", text: "No session." }, signal, undefined, client),
    ).rejects.toThrow("session");
    expect(client.transcribeWav).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });

  it.skipIf(!process.env.T3_CALL_TEST_SPEECH_CLIENT_MODULE)(
    "uses the real shared client for presence, WAV STT, streamed jobs and cleanup",
    async () => {
      const modulePath = process.env.T3_CALL_TEST_SPEECH_CLIENT_MODULE!;
      const module = (await import(NodeURL.pathToFileURL(modulePath).href)) as {
        createSpeechClient(options: {
          token: string;
          fetchImpl: typeof fetch;
        }): Promise<TestQueuedClient>;
      };
      const requests: string[] = [];
      let source!: ReadableStreamDefaultController<Uint8Array>;
      let streamClosed = false;
      const pcm = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
        cancel() {
          streamClosed = true;
        },
      });
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("http://127.0.0.1:8798");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"S".repeat(32)}`);
        const operation = `${init?.method} ${url.pathname}`;
        requests.push(operation);
        if (operation === "POST /v1/speech/conversations") {
          expect(JSON.parse(String(init?.body))).toEqual({
            ttlSeconds: 180,
            prepareTranscription: true,
          });
          return Response.json(
            { id: presenceId, ttlSeconds: 180, expiresAt: "2099-01-01T00:00:00Z" },
            { status: 201 },
          );
        }
        if (operation === "GET /v1/speech/status")
          return Response.json({
            healthy: true,
            sessionOpen: true,
            warmEngines: ["whisper-large-v3-turbo", "breeze-tts-2"],
          });
        if (operation === `POST /v1/speech/conversations/${presenceId}/renew`)
          return Response.json({
            id: presenceId,
            ttlSeconds: 180,
            expiresAt: "2099-01-01T00:01:00Z",
          });
        if (operation === "POST /v1/audio/transcriptions") {
          expect(new Headers(init?.headers).get("content-type")).toBe("audio/wav");
          expect(Buffer.from(init?.body as Uint8Array).subarray(44)).toEqual(Buffer.from([1, 0]));
          return Response.json({ text: "Real helper fixture." });
        }
        if (operation === "POST /v1/speech/jobs") {
          expect(JSON.parse(String(init?.body)).priority).toBe("call");
          return Response.json({ jobs: [{ id: ownedJob }] });
        }
        if (operation === `GET /v1/speech/jobs/${ownedJob}/stream`)
          return new Response(pcm, {
            headers: { "content-type": "audio/pcm", "x-sample-rate": "24000" },
          });
        if (operation === `DELETE /v1/speech/jobs/${ownedJob}`)
          return Response.json({ state: "cancelled" });
        if (operation === `DELETE /v1/speech/conversations/${presenceId}`)
          return Response.json({ ended: true });
        throw new Error("Unexpected shared client request");
      });
      const client = await module.createSpeechClient({ token: "S".repeat(32), fetchImpl: fetcher });
      const signal = new AbortController().signal;
      expect((await proxySpeech({ action: "acquire" }, signal, undefined, client)).sessionId).toBe(
        presenceId,
      );
      expect(
        (await proxySpeech({ action: "renew", sessionId: presenceId }, signal, undefined, client))
          .expiresAt,
      ).toBe("2099-01-01T00:01:00Z");
      expect(
        await proxySpeech(
          { action: "transcribe", sessionId: presenceId, sampleRate: 16000, audio: "AQA=" },
          signal,
          undefined,
          client,
        ),
      ).toEqual({ text: "Real helper fixture." });
      const audio = streamSpeech(
        { action: "speak", sessionId: presenceId, text: "Stream fixture." },
        signal,
        undefined,
        client,
      );
      const first = audio.next();
      source.enqueue(new Uint8Array([1, 0]));
      expect((await first).value).toEqual({ audio: "AQA=", sampleRate: 24000 });
      await audio.return(undefined);
      expect(streamClosed).toBe(true);
      expect(requests).toContain(`DELETE /v1/speech/jobs/${ownedJob}`);
      await proxySpeech({ action: "release", sessionId: presenceId }, signal, undefined, client);
      expect(requests.at(-1)).toBe(`DELETE /v1/speech/conversations/${presenceId}`);
    },
  );
});
