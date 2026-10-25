import type { CallStatus } from "@t3tools/contracts";
import type { VoiceState } from "./session";

const labels: Record<VoiceState, string> = {
  idle: "Call Otis",
  preparing: "Getting ready. You can type to Otis meanwhile.",
  listening: "Listening",
  saving: "Got it, writing that down",
  transcribing: "Got it, writing that down",
  waiting: "Otis is thinking",
  speaking: "Otis is talking",
  ready: "Listening",
  reconnecting: "Reconnecting",
  error: "Call needs attention",
};
export function callStatusLabel(
  state: VoiceState,
  call?: Pick<CallStatus, "operatorWorking" | "operatorUpdates" | "inputMode">,
) {
  if (["preparing", "reconnecting", "error", "speaking", "saving", "transcribing"].includes(state))
    return labels[state];
  const latest = call?.operatorUpdates?.findLast((update) => update.status !== "started");
  const text = latest?.text.replace(/\s+/g, " ").trim();
  if (latest?.status === "needs-Jared" && !latest.heardAt) return `Needs you: ${text}`;
  if (call?.operatorWorking)
    return `Background agent working: ${text && latest?.status === "progress" ? text : "Working on your request"}`;
  return call?.inputMode === "device" && (state === "listening" || state === "ready")
    ? "Listening (phone)"
    : labels[state];
}
export function callElapsedLabel(seconds: number) {
  return seconds >= 5 ? `${seconds}s` : "";
}
