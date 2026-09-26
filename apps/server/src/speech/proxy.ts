import type { SpeechRequest, SpeechResponse } from "@t3tools/contracts";

/** Fixed loopback destination: microphone audio never follows client-supplied URLs. */
export async function proxySpeech(
  input: SpeechRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
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
        model: "breeze-tts-2",
        input: input.text,
        voice: "otis",
        response_format: "pcm",
        stream: true,
      });
      break;
  }
  const response = await fetcher(`http://127.0.0.1:8085${path}`, {
    method,
    headers: {
      "content-type": contentType,
      ...(sessionId ? { "X-Voice-Session-Id": sessionId } : {}),
    },
    body,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
  });
  if (!response.ok) throw new Error(`Local speech service unavailable (${response.status}).`);
  if (input.action === "release" || input.action === "renew") return {};
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
    input.action === "acquire" &&
    "sessionId" in result &&
    typeof result.sessionId === "string" &&
    /^[\w-]{1,128}$/.test(result.sessionId)
  ) {
    return { sessionId: result.sessionId };
  }
  if (input.action === "transcribe" && "text" in result && typeof result.text === "string") {
    return { text: result.text };
  }
  throw new Error("Invalid speech response.");
}
