import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CommandId,
  MessageId,
  ThreadId,
  type CallOptions,
  type CallRequest,
  type CallStatus,
  type CallUtterance,
  type OrchestrationCommand,
  type SpeechResponse,
  type SpeechTransportRequest,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  callIdentifier,
  type CallStore,
  type CallRecord,
  type StoredConfirmation,
  sha256,
} from "./callStore.ts";

export interface CallPorts {
  verify(options: CallOptions): Promise<void>;
  dispatch(command: OrchestrationCommand): Promise<unknown>;
  speech(request: SpeechTransportRequest, signal: AbortSignal): Promise<SpeechResponse>;
  tenants: readonly [string, string];
  ttsModel: string;
}

/** Require an exact configured model and effort. No alias or default fallback. */
export function verifyCallModel(options: CallOptions, providers: readonly ServerProvider[]) {
  const provider = providers.find(
    (entry) => entry.instanceId === options.modelSelection.instanceId,
  );
  if (
    !provider ||
    provider.driver !== "claudeAgent" ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated"
  ) {
    throw new Error("Select an available, signed-in Claude provider for this call.");
  }
  const model = provider.models.find((entry) => entry.slug === options.modelSelection.model);
  if (!model)
    throw new Error(
      `Configure the exact model ${options.modelSelection.model} in this Claude provider's custom models first. No fallback was selected.`,
    );
  for (const option of options.modelSelection.options ?? []) {
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === option.id,
    );
    if (
      !descriptor ||
      (descriptor.type === "select" &&
        !descriptor.options.some((entry) => entry.id === option.value))
    ) {
      throw new Error(
        `The configured model does not advertise ${option.id}=${String(option.value)}. Choose a supported setting; it will not be silently dropped.`,
      );
    }
  }
}

const now = () => new Date().toISOString();
const active = (record: CallRecord) => {
  if (record.closed) throw new Error("This call has ended. Its saved speech is retained.");
};
const lease = (record: CallRecord) => {
  active(record);
  if (!record.lease || (record.leaseUntil ?? 0) <= Date.now())
    throw new Error("The speech lease expired. Resume preparation; saved speech is retained.");
  return record.lease;
};

export class CallService {
  constructor(
    readonly store: CallStore,
    private ports: CallPorts,
  ) {}

  async status(callId: string): Promise<CallStatus> {
    const record = await this.store.require(callId);
    const raws = await this.store.records<CallUtterance>(callId, ".raw.json");
    const confirmations = await this.store.records<StoredConfirmation>(
      callId,
      ".confirmation.json",
    );
    const played = await this.store.records<{ id: string }>(callId, ".played.json");
    return {
      callId,
      threadId: record.threadId,
      version: record.version,
      ready: !record.closed && !!record.lease && (record.leaseUntil ?? 0) > Date.now(),
      closed: record.closed,
      modelSelection: record.modelSelection,
      policy: record.policy,
      steps: record.steps,
      utterances: await Promise.all(raws.map((raw) => this.store.utterance(callId, raw.id))),
      pending: confirmations
        .filter((item) => !item.decision)
        .map(({ id, tool, summary, level }) => ({ id, tool, summary, level })),
      played: played.map((item) => item.id),
    };
  }
  async handle(input: CallRequest, signal: AbortSignal): Promise<SpeechResponse> {
    callIdentifier(input.callId);
    if (input.action === "call.watch") {
      await this.store.wait(input.callId, input.version, signal);
      return { call: await this.status(input.callId) };
    }
    return this.store.serial(input.callId, async () => {
      if (input.action === "call.open")
        return this.store.serial(`thread:${input.options?.threadId}`, () => this.open(input));
      const record = await this.store.require(input.callId);
      switch (input.action) {
        case "call.status":
          return { call: await this.status(input.callId) };
        case "call.upload":
          return { utterance: await this.upload(record, input) };
        case "call.transcribe":
          return { utterance: await this.transcribe(record, callIdentifier(input.utteranceId)) };
        case "call.deliver":
          return { utterance: await this.deliver(record, callIdentifier(input.utteranceId)) };
        case "call.prepare":
          await this.prepare(record);
          break;
        case "call.renew":
          await this.ports.speech(
            { action: "renew", sessionId: lease(record) },
            AbortSignal.timeout(90_000),
          );
          record.leaseUntil = Date.now() + 110_000;
          await this.store.changed(record);
          break;
        case "call.speak":
          return this.speak(record, input, signal);
        case "call.played":
          await this.store.write(record.callId, `${callIdentifier(input.speechId)}.played.json`, {
            id: input.speechId,
            at: now(),
          });
          await this.store.changed(record);
          break;
        case "call.confirm":
          await this.confirm(record, callIdentifier(input.confirmationId), input.decision);
          break;
        case "call.interrupt":
          await this.interrupt(record, callIdentifier(input.utteranceId));
          break;
        case "call.close":
          // Persist the closed fence before interrupting. Late tools cannot escape it.
          record.closed = true;
          await this.store.changed(record);
          try {
            await this.interrupt(record, "close");
          } finally {
            if (record.lease) {
              await this.ports.speech(
                { action: "release", sessionId: record.lease },
                AbortSignal.timeout(90_000),
              );
              delete record.lease;
              await this.store.changed(record);
            }
          }
          break;
      }
      return { call: await this.status(input.callId) };
    });
  }
  private async open(input: CallRequest): Promise<SpeechResponse> {
    if (!input.options) throw new Error("Call options are required.");
    const previous = await this.store.read<CallRecord>(input.callId, "call.json");
    if (previous) {
      if (
        JSON.stringify([previous.threadId, previous.modelSelection, previous.policy]) !==
        JSON.stringify([input.options.threadId, input.options.modelSelection, input.options.policy])
      )
        throw new Error("Call ID already belongs to different options.");
      active(previous);
      return { call: await this.status(input.callId) };
    }
    await this.ports.verify(input.options);
    const bindingName = `${sha256(input.options.threadId)}.json`;
    const binding = await this.store.read<{ callId: string }>("_threads", bindingName);
    if (binding && !(await this.store.require(binding.callId)).closed)
      throw new Error(
        "This chat already has a call. Resume it from the device that started it or end that call first.",
      );
    const record: CallRecord = {
      ...input.options,
      callId: input.callId,
      createdAt: now(),
      version: "",
      closed: false,
      steps: ["Call log saved on PC", "Exact Claude model and thinking setting configured"],
    };
    await this.store.changed(record);
    await this.store.write("_threads", bindingName, { callId: input.callId });
    return { call: await this.status(input.callId) };
  }
  private async prepare(record: CallRecord) {
    active(record);
    await this.ports.verify(record);
    if (record.lease && (record.leaseUntil ?? 0) > Date.now()) return;
    const result = await this.ports.speech({ action: "acquire" }, AbortSignal.timeout(90_000));
    if (!result.sessionId) throw new Error("The router did not grant a speech lease.");
    if (!this.ports.tenants.every((id) => result.tenants?.includes(id))) {
      await this.ports.speech(
        { action: "release", sessionId: result.sessionId },
        AbortSignal.timeout(90_000),
      );
      throw new Error(
        "Router speech tenants do not match the configured call profile. Ask the router owner to configure the STT and TTS tenants.",
      );
    }
    record.lease = result.sessionId;
    record.leaseUntil = Date.now() + 110_000;
    record.steps = [
      ...record.steps.slice(0, 2),
      "Router granted the call profile; speech tenants ready",
    ];
    try {
      await this.store.changed(record);
    } catch (error) {
      await this.ports.speech(
        { action: "release", sessionId: result.sessionId },
        AbortSignal.timeout(90_000),
      );
      throw error;
    }
  }
  private async upload(record: CallRecord, input: CallRequest) {
    // Upload remains available after hang-up, so a disconnected phone can save
    // its final recording. Closed calls never transcribe or deliver new work.
    const id = callIdentifier(input.utteranceId);
    const rate = input.sampleRate;
    if (
      !rate ||
      !Number.isInteger(rate) ||
      rate < 8000 ||
      rate > 96000 ||
      !input.audio ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audio)
    )
      throw new Error("Invalid PCM recording.");
    const audio = Buffer.from(input.audio, "base64");
    if (!audio.length || audio.length % 2 || audio.length > rate * 2 * 60)
      throw new Error("Record up to one minute of speech per utterance.");
    const started = Date.parse(input.startedAt ?? "");
    const ended = Date.parse(input.endedAt ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started)
      throw new Error("Recording timestamps are required.");
    const hash = sha256(audio);
    const existing = await this.store.read<CallUtterance>(record.callId, `${id}.raw.json`);
    if (existing) {
      if (
        existing.sha256 !== hash ||
        existing.sampleRate !== rate ||
        existing.startedAt !== input.startedAt ||
        existing.endedAt !== input.endedAt ||
        existing.confirmationId !== input.confirmationId
      )
        throw new Error("Utterance ID already belongs to different audio or metadata.");
      return this.store.utterance(record.callId, id);
    }
    if ((await this.store.records(record.callId, ".raw.json")).length >= 1000)
      throw new Error("Start a new call after 1000 utterances. Existing recordings are retained.");
    const raw: CallUtterance = {
      id,
      sha256: hash,
      bytes: audio.length,
      sampleRate: rate,
      startedAt: input.startedAt!,
      endedAt: input.endedAt!,
      savedAt: now(),
      ...(input.confirmationId ? { confirmationId: callIdentifier(input.confirmationId) } : {}),
    };
    try {
      const orphan = await readFile(join(this.store.directory(record.callId), `${id}.pcm`));
      if (sha256(orphan) !== hash)
        throw new Error("Utterance ID already has saved audio. It will not be overwritten.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.store.writeBytes(record.callId, `${id}.pcm`, audio);
    await this.store.write(record.callId, `${id}.raw.json`, raw);
    await this.store.changed(record);
    return raw;
  }
  private async transcribe(record: CallRecord, id: string) {
    const raw = await this.store.utterance(record.callId, id);
    if (raw.transcribedAt) return raw;
    const audio = await readFile(join(this.store.directory(record.callId), `${id}.pcm`));
    if (sha256(audio) !== raw.sha256)
      throw new Error("Saved recording failed its integrity check.");
    const result = await this.ports.speech(
      {
        action: "transcribe",
        sessionId: lease(record),
        audio: audio.toString("base64"),
        sampleRate: raw.sampleRate,
      },
      AbortSignal.timeout(90_000),
    );
    if (typeof result.text !== "string")
      throw new Error("The speech engine returned no transcript.");
    await this.store.write(record.callId, `${id}.transcript.json`, {
      text: result.text,
      transcribedAt: now(),
    });
    await this.store.changed(record);
    return this.store.utterance(record.callId, id);
  }
  private async deliver(record: CallRecord, id: string) {
    const utterance = await this.store.utterance(record.callId, id);
    if (utterance.deliveredAt) return utterance;
    active(record);
    if (!utterance.transcribedAt || utterance.text === undefined)
      throw new Error("Save the transcript before delivery.");
    const messageId = `voice:${record.callId}:${id}`;
    if (utterance.confirmationId) {
      await this.ports.dispatch({
        type: "thread.voice.transcript",
        commandId: CommandId.make(messageId),
        threadId: ThreadId.make(record.threadId),
        messageId: MessageId.make(messageId),
        text: utterance.text,
        createdAt: utterance.savedAt,
      });
      const word = utterance.text
        .trim()
        .toLowerCase()
        .replace(/[.!?]+$/, "");
      if (word !== "yes" && word !== "no")
        throw new Error(
          "Confirmation needs exactly yes or no. The recording is saved; confirm with the button or record again.",
        );
      await this.confirm(record, utterance.confirmationId, word);
    } else if (utterance.text.trim()) {
      await this.ports.verify(record);
      await this.ports.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(messageId),
        threadId: ThreadId.make(record.threadId),
        message: {
          messageId: MessageId.make(messageId),
          role: "user",
          text: utterance.text,
          attachments: [],
        },
        modelSelection: record.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: utterance.savedAt,
      });
    }
    await this.store.write(record.callId, `${id}.delivery.json`, { deliveredAt: now(), messageId });
    await this.store.changed(record);
    return this.store.utterance(record.callId, id);
  }
  private async speak(
    record: CallRecord,
    input: CallRequest,
    signal: AbortSignal,
  ): Promise<SpeechResponse> {
    const id = callIdentifier(input.speechId);
    if (!input.text?.trim() || input.text.length > 1600) throw new Error("Invalid speech text.");
    const existing = await this.store.read<{ text: string }>(record.callId, `${id}.speech.json`);
    if (existing && existing.text !== input.text)
      throw new Error("Speech ID already belongs to different text.");
    if (!existing)
      await this.store.write(record.callId, `${id}.speech.json`, { text: input.text, at: now() });
    return this.ports.speech(
      { action: "speak", sessionId: lease(record), model: this.ports.ttsModel, text: input.text },
      signal,
    );
  }
  private async confirm(record: CallRecord, id: string, decision: "yes" | "no" | undefined) {
    active(record);
    if (!decision) throw new Error("An explicit yes or no is required.");
    const confirmation = await this.store.read<StoredConfirmation>(
      record.callId,
      `${id}.confirmation.json`,
    );
    if (!confirmation) throw new Error("That tool confirmation is no longer available.");
    if (confirmation.decision && confirmation.decision !== decision)
      throw new Error("That tool invocation was already answered.");
    await this.store.write(record.callId, `${id}.confirmation.json`, { ...confirmation, decision });
    await this.store.changed(record);
  }
  private async interrupt(record: CallRecord, id: string) {
    await this.ports.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(`voice-interrupt:${record.callId}:${id}`),
      threadId: ThreadId.make(record.threadId),
      createdAt: record.createdAt,
    });
  }
}
