import { CALL_PREPARE_TIMEOUT_MS, type SpeechRequest } from "@t3tools/contracts";

export function voiceRequestTimeoutMs(action: SpeechRequest["action"], streamAudio = false) {
  if (action === "call.prepare" || action === "acquire") return CALL_PREPARE_TIMEOUT_MS + 60_000;
  if (action === "call.watch") return 35_000;
  if (action === "call.speak" || action === "speak") return streamAudio ? 120_000 : 90_000;
  if (action === "call.transcribe" || action === "transcribe" || action === "call.upload")
    return 100_000;
  return 30_000;
}
