import { describe, expect, it, vi } from "vite-plus/test";
import { proxySpeech } from "./proxy.ts";

describe("local speech proxy", () => {
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
