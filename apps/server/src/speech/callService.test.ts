import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type CallOptions, type CallRequest, type ServerProvider, type SpeechTransportRequest } from "@t3tools/contracts";
import { CallStore, sha256 } from "./callStore.ts";
import { CallService, verifyCallModel, type CallPorts } from "./callService.ts";
import { callToolHook } from "./callToolGate.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const options: CallOptions = { threadId: "synthetic-thread", policy: "confirm-actions", modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5", options: [{ id: "effort", value: "medium" }] } };
const pcm = Buffer.from([1, 0, 2, 0]);
const upload: CallRequest = { action: "call.upload", callId: "call-1", utteranceId: "utterance-1", audio: pcm.toString("base64"), sampleRate: 16000, startedAt: "2026-10-18T00:00:00.000Z", endedAt: "2026-10-18T00:00:01.000Z" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "t3-call-synthetic-")); directories.push(directory);
  const store = new CallStore(directory);
  const ports: CallPorts = {
    verify: vi.fn(async () => {}), dispatch: vi.fn(async () => ({ sequence: 1 })),
    speech: vi.fn(async (input: SpeechTransportRequest) => input.action === "acquire"
      ? { sessionId: "lease-1", tenants: ["stt", "tts"] }
      : input.action === "transcribe" ? { text: "Read the build status." }
      : input.action === "speak" ? { audio: pcm.toString("base64"), sampleRate: 16000 } : {}),
    tenants: ["stt", "tts"], ttsModel: "synthetic-tts",
  };
  const service = new CallService(store, ports);
  const request = (input: Omit<CallRequest, "callId">) => service.handle({ callId: "call-1", ...input }, new AbortController().signal);
  await request({ action: "call.open", options });
  await request({ action: "call.prepare" });
  return { store, service, ports, request, directory };
}

describe("durable calls", () => {
  it("flushes raw PCM before STT and transcript before normal chat dispatch", async () => {
    const f = await fixture();
    const originalSpeech = f.ports.speech;
    f.ports.speech = vi.fn(async (input, signal) => {
      if (input.action === "transcribe") {
        expect(await readFile(join(f.directory, "call-1", "utterance-1.pcm"))).toEqual(pcm);
        expect((await f.store.utterance("call-1", "utterance-1")).sha256).toBe(sha256(pcm));
      }
      return originalSpeech(input, signal);
    });
    f.ports.dispatch = vi.fn(async (command) => {
      expect((await f.store.utterance("call-1", "utterance-1")).text).toBe("Read the build status.");
      expect(command.type).toBe("thread.turn.start");
      if (command.type === "thread.turn.start") expect(command.modelSelection).toEqual(options.modelSelection);
    });
    const saved = await f.service.handle(upload, new AbortController().signal);
    expect(saved.utterance?.bytes).toBe(4);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost upload acknowledgment and a lost delivery response with one message identity", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal); // response lost
    const restarted = new CallService(new CallStore(f.directory), f.ports);
    await restarted.handle(upload, new AbortController().signal);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    const accepted = new Set<string>();
    let first = true;
    f.ports.dispatch = vi.fn(async (command) => {
      accepted.add(command.commandId);
      if (first) { first = false; throw new Error("Response lost after commit"); }
    });
    await expect(f.request({ action: "call.deliver", utteranceId: "utterance-1" })).rejects.toThrow("Response lost");
    const response = await restarted.handle({ action: "call.deliver", callId: "call-1", utteranceId: "utterance-1" }, new AbortController().signal);
    expect(response.utterance?.messageId).toBe("voice:call-1:utterance-1");
    expect(accepted.size).toBe(1);
    await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(2);
  });
  it("rejects conflicting retry payloads and preserves the original audio", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal);
    await expect(f.service.handle({ ...upload, audio: "AwAEAA==" }, new AbortController().signal)).rejects.toThrow("different audio");
    expect(await readFile(join(f.directory, "call-1", "utterance-1.pcm"))).toEqual(pcm);
  });
  it("preserves orphaned PCM when metadata persistence did not complete", async () => {
    const f = await fixture();
    await f.store.writeBytes("call-1", "utterance-1.pcm", pcm);
    await expect(f.service.handle({ ...upload, audio: "AwAEAA==" }, new AbortController().signal)).rejects.toThrow("will not be overwritten");
    await f.service.handle(upload, new AbortController().signal);
  });
  it("never invokes STT before raw acknowledgment or the agent before a saved transcript", async () => {
    const f = await fixture();
    await expect(f.request({ action: "call.transcribe", utteranceId: "missing" })).rejects.toThrow("Upload");
    await f.service.handle(upload, new AbortController().signal);
    await expect(f.request({ action: "call.deliver", utteranceId: "utterance-1" })).rejects.toThrow("Save the transcript");
    expect(f.ports.dispatch).not.toHaveBeenCalled();
  });
  it("deduplicates simultaneous transcription and delivery retries", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal);
    await Promise.all([1, 2, 3].map(() => f.request({ action: "call.transcribe", utteranceId: "utterance-1" })));
    await Promise.all([1, 2, 3].map(() => f.request({ action: "call.deliver", utteranceId: "utterance-1" })));
    expect(vi.mocked(f.ports.speech).mock.calls.filter(([request]) => request.action === "transcribe")).toHaveLength(1);
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it("releases a mismatched GPU profile without reporting ready", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1"); delete record.lease; await f.store.changed(record);
    f.ports.speech = vi.fn(async () => ({ sessionId: "wrong", tenants: ["unrelated-model"] }));
    await expect(f.request({ action: "call.prepare" })).rejects.toThrow("do not match");
    expect(f.ports.speech).toHaveBeenLastCalledWith({ action: "release", sessionId: "wrong" }, expect.any(AbortSignal));
    expect((await f.service.status("call-1")).ready).toBe(false);
  });
  it("retains final offline uploads after close, but never delivers them", async () => {
    const f = await fixture();
    await f.request({ action: "call.close" });
    await f.service.handle(upload, new AbortController().signal);
    await expect(f.request({ action: "call.transcribe", utteranceId: "utterance-1" })).rejects.toThrow("ended");
    expect((await f.service.status("call-1")).utterances).toHaveLength(1);
  });
  it("rejects path traversal and malformed PCM without writing a recording", async () => {
    const f = await fixture();
    await expect(f.service.handle({ ...upload, utteranceId: "../escape" }, new AbortController().signal)).rejects.toThrow("ID");
    await expect(f.service.handle({ ...upload, audio: "%%%" }, new AbortController().signal)).rejects.toThrow("PCM");
    expect((await f.service.status("call-1")).utterances).toHaveLength(0);
  });
});

describe("tool execution confirmation", () => {
  async function pendingTool(f: Awaited<ReturnType<typeof fixture>>, name = "mcp__otis__start_agent") {
    const record = await f.store.require("call-1");
    const hook = callToolHook(f.store, options.threadId, () => "call-1");
    const result = hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: { task: "Synthetic build" }, tool_use_id: "tool-1", session_id: "synthetic", transcript_path: "synthetic", cwd: f.directory }, "tool-1", { signal: new AbortController().signal });
    await f.store.wait("call-1", record.version, new AbortController().signal);
    return { result, pending: (await f.service.status("call-1")).pending[0]! };
  }
  it("holds an agent launch at PreToolUse until its exact invocation is confirmed", async () => {
    const f = await fixture();
    const { result, pending } = await pendingTool(f);
    expect(pending.level).toBe("read-back");
    await f.request({ action: "call.confirm", confirmationId: pending.id, decision: "yes" });
    expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });
  it("denies pending tools when the call closes", async () => {
    const f = await fixture(); const { result } = await pendingTool(f, "mcp__otis__deploy");
    await f.request({ action: "call.close" });
    expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  it("records a spoken yes in chat and resolves only the bound confirmation", async () => {
    const f = await fixture(); const { result, pending } = await pendingTool(f);
    f.ports.speech = vi.fn(async () => ({ text: "Yes." }));
    await f.service.handle({ ...upload, confirmationId: pending.id }, new AbortController().signal);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(f.ports.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.voice.transcript", text: "Yes." }));
    expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });
  it("does not interpret a sentence containing yes as consent", async () => {
    const f = await fixture(); const { result, pending } = await pendingTool(f);
    f.ports.speech = vi.fn(async () => ({ text: "Yesterday I said yes, but do not run it." }));
    await f.service.handle({ ...upload, confirmationId: pending.id }, new AbortController().signal);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    await expect(f.request({ action: "call.deliver", utteranceId: "utterance-1" })).rejects.toThrow("exactly yes or no");
    expect((await f.service.status("call-1")).pending).toHaveLength(1);
    await f.request({ action: "call.confirm", confirmationId: pending.id, decision: "no" });
    expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

describe("exact call model", () => {
  const provider: ServerProvider = { instanceId: options.modelSelection.instanceId, driver: "claudeAgent" as ServerProvider["driver"], enabled: true, installed: true, version: "synthetic", status: "ready", auth: { status: "authenticated" }, checkedAt: "2026-10-18T00:00:00.000Z", models: [{ slug: "claude-haiku-5-5", name: "Synthetic Haiku 5.5 configuration", isCustom: true, capabilities: { optionDescriptors: [{ id: "effort", type: "select", label: "Thinking", options: [{ id: "medium", label: "Medium" }] }] } }], slashCommands: [], skills: [] };
  it("accepts a configured 5.5 model and medium without replacing either", () => { expect(() => verifyCallModel(options, [provider])).not.toThrow(); });
  it("refuses an absent model instead of choosing 4.5", () => { expect(() => verifyCallModel(options, [{ ...provider, models: [{ ...provider.models[0]!, slug: "claude-haiku-4-5" }] }])).toThrow("No fallback"); });
  it("refuses unsupported thinking instead of dropping it", () => { expect(() => verifyCallModel(options, [{ ...provider, models: [{ ...provider.models[0]!, capabilities: null }] }])).toThrow("silently dropped"); });
});
