// @effect-diagnostics nodeBuiltinImport:off - Mock the Node HTTP boundary used for cold acquisition.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { proxySpeech, streamSpeech, speechInputMode } from "./proxy.ts";

vi.mock("node:http", () => ({ request: vi.fn() }));

describe("local speech proxy", () => {
  it.each([
    [true, true, "pc"],
    [false, true, "device"],
    [true, false, "device"],
  ] as const)(
    "chooses input from running=%s and healthy=%s without acquiring",
    async (running, healthy, expected) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          speech: {
            tenants: [{ id: "whisper", running, healthy }],
          },
        }),
      );
      expect(await speechInputMode(new AbortController().signal, "whisper", false, fetcher)).toBe(
        expected,
      );
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        "http://127.0.0.1:8085/health",
        expect.objectContaining({ method: "GET" }),
      );
    },
  );
  it("forces device input without probing or acquiring whisper", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await speechInputMode(new AbortController().signal, "whisper", true, fetcher)).toBe(
      "device",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses device input when health is missing or unavailable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}))
      .mockRejectedValueOnce(new TypeError("offline"));
    expect(await speechInputMode(new AbortController().signal, "whisper", false, fetcher)).toBe(
      "device",
    );
    expect(await speechInputMode(new AbortController().signal, "whisper", false, fetcher)).toBe(
      "device",
    );
  });
  it("requests exactly the TTS tenant for device calls", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ sessionId: "tts-only", tenants: ["breeze"] }));
    await proxySpeech(
      { action: "acquire", tenants: ["breeze"] },
      new AbortController().signal,
      fetcher,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      client: "t3-code",
      ttlSeconds: 120,
      tenants: ["breeze"],
    });
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
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Request-Id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
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
