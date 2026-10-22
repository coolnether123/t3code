import type { CallCommand as OrchestrationCommand } from "./commands.ts";
// @effect-diagnostics nodeBuiltinImport:off - Read the retained PCM archive through the Node storage boundary.
import * as NodeFSP from "node:fs/promises";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";
import {
  CommandId,
  EventId,
  CALL_PREPARE_TIMEOUT_MS,
  MessageId,
  ThreadId,
  ValidCallRequest,
  type CallOptions,
  type CallRequest,
  type CallStatus,
  type CallUtterance,
  type SpeechResponse,
  type SpeechTransportRequest,
  type ServerProvider,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { callIdentifier, type CallStore, type CallRecord, sha256 } from "./callStore.ts";
import type { CallOperator } from "./callOperator.ts";
import { BackchannelClips } from "./backchannelClips.ts";

export interface CallPorts {
  verify(
    options: CallOptions,
  ): Promise<{ runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode }>;
  dispatch(command: OrchestrationCommand): Promise<unknown>;
  speech(request: SpeechTransportRequest, signal: AbortSignal): Promise<SpeechResponse>;
  speechStream?(
    request: SpeechTransportRequest,
    signal: AbortSignal,
  ): AsyncIterable<SpeechResponse>;
  tenants: readonly [string, string];
  ttsModel: string;
  inputMode?(signal: AbortSignal): Promise<"pc" | "device">;
  verifyVoice?(selection: CallOptions["modelSelection"]): Promise<void>;
}

/** Require an exact configured model and effort. No alias or default fallback. */
export function verifyCallModel(options: CallOptions, providers: readonly ServerProvider[]) {
  const provider = providers.find(
    (entry) => entry.instanceId === options.modelSelection.instanceId,
  );
  if (
    !provider ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated"
  ) {
    throw new Error("Select an available, signed-in provider in this chat.");
  }
  const model = provider.models.find((entry) => entry.slug === options.modelSelection.model);
  if (!model)
    throw new Error(
      `The selected provider does not advertise ${options.modelSelection.model}. Choose an available model in the chat selector. No fallback was selected.`,
    );
  for (const option of options.modelSelection.options ?? []) {
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === option.id,
    );
    if (
      !descriptor ||
      (descriptor.type === "boolean" && typeof option.value !== "boolean") ||
      (descriptor.type === "select" &&
        !descriptor.options.some((entry) => entry.id === option.value))
    ) {
      throw new Error(
        `The configured model does not advertise ${option.id}=${String(option.value)}. Choose a supported setting; it will not be silently dropped.`,
      );
    }
  }
}

const decodeCallRequest = Schema.decodeUnknownSync(ValidCallRequest);
const now = () => DateTime.formatIso(Effect.runSync(DateTime.now));
const time = () => Effect.runSync(Clock.currentTimeMillis);
const ABANDONED_CALL_MS = 600_000;
const expiry = (response: SpeechResponse) => {
  const until = Date.parse(response.expiresAt ?? "");
  if (!Number.isFinite(until) || until <= time())
    throw new Error("Router returned an invalid speech lease expiry.");
  return until;
};
const active = (record: CallRecord) => {
  if (record.closed) throw new Error("This call has ended. Its saved speech is retained.");
};
type PartialWindow = {
  revision: number;
  sampleRate: number;
  pcm: Buffer;
  result: Promise<SpeechResponse>;
};
const lease = (record: CallRecord) => {
  active(record);
  if (!record.lease || (record.leaseUntil ?? 0) <= time())
    throw new Error("The speech lease expired. Resume preparation; saved speech is retained.");
  return record.lease;
};

export class CallService {
  private static recognition = new WeakMap<CallStore, Map<string, PartialWindow>>();
  private static clips = new WeakMap<CallStore, BackchannelClips>();
  private partials: Map<string, PartialWindow>;
  readonly store: CallStore;
  private ports: CallPorts;
  private operator: CallOperator | undefined;
  private backchannels: BackchannelClips;
  constructor(store: CallStore, ports: CallPorts, operator?: CallOperator) {
    this.store = store;
    // HTTP constructs a service per request; capture windows belong to the retained store.
    this.partials = CallService.recognition.get(store) ?? new Map();
    CallService.recognition.set(store, this.partials);
    this.ports = ports;
    this.operator = operator;
    this.backchannels = CallService.clips.get(store) ?? new BackchannelClips(store.root);
    CallService.clips.set(store, this.backchannels);
  }

  async status(callId: string): Promise<CallStatus> {
    await this.recoverExpirations();
    const record = await this.store.require(callId);
    const operator = await this.operator?.read(record.threadId);
    return {
      callId,
      threadId: record.threadId,
      version: record.version,
      ready: !record.closed && !!record.lease && (record.leaseUntil ?? 0) > time(),
      inputMode: record.inputMode ?? "pc",
      closed: record.closed,
      modelSelection: record.modelSelection,
      steps: record.steps,
      utterances: await Promise.all(
        (record.recentUtterances ?? []).map((id) => this.store.utterance(callId, id)),
      ),
      played: record.recentPlayed ?? [],
      ...(this.operator
        ? {
            operatorUpdates: operator?.updates ?? [],
            voiceRunning: operator?.voices.some((voice) => !voice.finished) ?? false,
            operatorWorking: operator?.jobs.some((job) => job.phase !== "done") ?? false,
          }
        : {}),
    };
  }
  private recoverExpirations() {
    return this.store.recoverExpirations((callId) => this.expire(callId));
  }
  private scheduleExpiry(callId: string, until: number) {
    this.store.scheduleExpiry(callId, until, () => this.expire(callId));
  }
  private expire(callId: string) {
    return this.store.serial(`renew:${callId}`, async () => {
      let deadline = 0;
      let abandoned = false;
      await this.store.serial(callId, async () => {
        const record = await this.store.require(callId);
        if (record.closed) return;
        deadline = (record.lastClientAt ?? Date.parse(record.createdAt)) + ABANDONED_CALL_MS;
        if (deadline <= time()) {
          abandoned = true;
          return;
        }
        if (
          (record.lease || record.leaseUntil !== undefined) &&
          (record.leaseUntil ?? 0) <= time()
        ) {
          delete record.lease;
          delete record.leaseUntil;
          await this.store.changed(record);
        }
        if (record.lease && record.leaseUntil) deadline = Math.min(deadline, record.leaseUntil);
      });
      if (!deadline) return;
      if (abandoned) await this.close(callId);
      else this.scheduleExpiry(callId, deadline);
    });
  }
  private async contact(
    callId: string,
    signal: AbortSignal,
    ensureSpeech = true,
    forceRenew = false,
  ) {
    const record = await this.store.serial(callId, async () => {
      const current = await this.store.require(callId);
      if (!current.closed) {
        current.lastClientAt = time();
        // Contact must not wake its own long-poll or change the watched version.
        await this.store.write(callId, "call.json", current);
        this.scheduleExpiry(
          callId,
          Math.min(
            current.leaseUntil && current.leaseUntil > time() ? current.leaseUntil : Infinity,
            current.lastClientAt + ABANDONED_CALL_MS,
          ),
        );
      }
      return current;
    });
    if (record.closed || !ensureSpeech) return;
    if (!forceRenew && record.lease && (record.leaseUntil ?? 0) - time() > 60_000) return;
    return this.store.serial(`renew:${callId}`, async () => {
      const record = await this.store.require(callId);
      if (record.closed) return;
      if (!forceRenew && record.lease && (record.leaseUntil ?? 0) - time() > 60_000) return;
      if (record.lease && (record.leaseUntil ?? 0) > time()) {
        try {
          await this.renewLease(callId, signal);
          return;
        } catch {
          signal.throwIfAborted();
        }
      }
      await this.prepare(callId, signal, undefined, undefined, true);
    });
  }
  async handle(input: CallRequest, signal: AbortSignal): Promise<SpeechResponse> {
    for (const id of [input.callId, input.utteranceId, input.speechId])
      if (id !== undefined) callIdentifier(id);
    decodeCallRequest(input);
    callIdentifier(input.callId);
    await this.recoverExpirations();
    if (input.action === "call.partial") return this.partial(input, signal);
    if (input.action === "call.backchannel") {
      const record = await this.store.require(input.callId);
      const sessionId = lease(record);
      if (input.revision && input.startedAt) {
        await this.backchannels.record(input.callId, input.text!, input.revision, input.startedAt);
        return {};
      }
      return this.backchannels.get(input.text!, this.ports.ttsModel, () =>
        this.ports.speech(
          // Breeze renders the hyphenated spelling as a longer utterance.
          {
            action: "speak",
            sessionId,
            model: this.ports.ttsModel,
            text: input.text === "mm-hmm" ? "Mhm." : "mm",
          },
          signal,
        ),
      );
    }
    if (!["call.open", "call.close", "call.configure"].includes(input.action))
      await this.contact(
        input.callId,
        signal,
        input.action !== "call.prepare",
        input.action === "call.renew",
      );
    if (input.action === "call.configure") {
      if (!this.operator || !input.options)
        throw new Error("Call model configuration is unavailable.");
      const existing = await this.operator.read(input.options.threadId);
      const defaults = await this.operator.defaults();
      if (!input.options.operatorSelection)
        return {
          ...((existing?.models ?? defaults) ? { models: existing?.models ?? defaults! } : {}),
          ...(defaults ? { defaultModels: defaults } : {}),
          operatorUpdates: existing?.updates ?? [],
        };
      const models = {
        voice: input.options.modelSelection,
        operator: input.options.operatorSelection,
      };
      await this.ports.verifyVoice?.(models.voice);
      await this.ports.verify({ threadId: input.options.threadId, modelSelection: models.voice });
      await this.ports.verify({
        threadId: input.options.threadId,
        modelSelection: models.operator,
      });
      return {
        models: await this.operator.configure(input.options.threadId, models, input.saveDefault),
      };
    }
    if (input.action === "call.announce" || input.action === "call.heard") {
      const record = await this.store.require(input.callId);
      if (!this.operator) throw new Error("Call operator is unavailable.");
      if (input.action === "call.announce") {
        active(record);
        const announced = await this.operator.announce(record.threadId, record.callId);
        return { call: await this.status(input.callId), announced };
      } else await this.operator.heard(record.threadId, input.updateIds ?? []);
      return { call: await this.status(input.callId) };
    }
    if (input.action === "call.watch") {
      await this.store.wait(input.callId, input.version, signal);
      await this.contact(input.callId, signal);
      return { call: await this.status(input.callId) };
    }
    if (input.action === "call.say") {
      const id = callIdentifier(input.utteranceId);
      const origin = input.retryOf ?? { callId: input.callId, utteranceId: id };
      return this.store.serial(`call.deliver:${origin.callId}:${origin.utteranceId}`, async () => {
        const record = await this.store.require(input.callId);
        active(record);
        const text = input.text!.trim();
        if (input.retryOf) {
          const source = await this.store.require(origin.callId);
          const original = await this.store.read<CallUtterance>(
            origin.callId,
            `${origin.utteranceId}.typed.json`,
          );
          if (source.threadId !== record.threadId || (original && original.text !== text))
            throw new Error("Recovered typed turn does not match its original chat and text.");
        }
        const previous = await this.store.read<CallUtterance>(input.callId, `${id}.typed.json`);
        if (await this.store.read(input.callId, `${id}.raw.json`))
          throw new Error("This utterance ID already belongs to a recording.");
        if (
          previous &&
          (previous.text !== text ||
            JSON.stringify(previous.retryOf) !== JSON.stringify(input.retryOf))
        )
          throw new Error("Typed utterance identity does not match its saved text.");
        if (!previous) {
          const at = now();
          await this.store.write(input.callId, `${id}.typed.json`, {
            id,
            source: "typed",
            ...(input.retryOf ? { retryOf: input.retryOf } : {}),
            text,
            sha256: sha256(text),
            bytes: Buffer.byteLength(text),
            sampleRate: 0,
            startedAt: at,
            endedAt: at,
            savedAt: at,
            transcribedAt: at,
            modelSelection: input.modelSelection ?? record.modelSelection,
            ...(input.operatorSelection ? { operatorSelection: input.operatorSelection } : {}),
          });
          await this.store.serial(input.callId, async () => {
            const current = await this.store.require(input.callId);
            current.recentUtterances = [
              ...new Set([...(current.recentUtterances ?? []), id]),
            ].slice(-64);
            await this.store.changed(current);
          });
        }
        const utterance = await this.deliver(record, id);
        return { utterance, call: await this.status(input.callId) };
      });
    }
    // Engine work owns an operation lock, never the call's short state lock.
    if (input.action === "call.prepare") {
      await this.store.serial(`renew:${input.callId}`, () =>
        this.prepare(input.callId, signal, input.modelSelection, input.operatorSelection),
      );
      return { call: await this.status(input.callId) };
    }
    if (input.action === "call.renew") {
      return { call: await this.status(input.callId) };
    }
    if (
      input.action === "call.transcribe" ||
      input.action === "call.speak" ||
      input.action === "call.deliver"
    ) {
      return this.store.serial(
        `${input.action}:${input.callId}:${input.utteranceId ?? input.speechId}`,
        async () => {
          const record = await this.store.require(input.callId);
          if (input.action === "call.transcribe")
            return { utterance: await this.transcribe(record, callIdentifier(input.utteranceId)) };
          if (input.action === "call.deliver")
            return { utterance: await this.deliver(record, callIdentifier(input.utteranceId)) };
          return this.speak(record, input, signal);
        },
      );
    }
    if (input.action === "call.close") {
      return (await this.close(input.callId)) ? { call: await this.status(input.callId) } : {};
    }
    return this.store.serial(input.callId, async () => {
      if (input.action === "call.open")
        return this.store.serial(`thread:${input.options?.threadId}`, () => this.open(input));
      const record = await this.store.require(input.callId);
      switch (input.action) {
        case "call.status":
          return { call: await this.status(input.callId) };
        case "call.upload":
          this.partials.delete(`${input.callId}:${input.utteranceId}`);
          return { utterance: await this.upload(record, input) };
        case "call.played":
          await this.store.write(record.callId, `${callIdentifier(input.speechId)}.played.json`, {
            id: input.speechId,
            at: now(),
          });
          record.recentPlayed = [
            ...(record.recentPlayed ?? []).filter((id) => id !== input.speechId),
            input.speechId!,
          ].slice(-128);
          await this.store.changed(record);
          break;
        case "call.interrupt":
          await this.interrupt(record, callIdentifier(input.utteranceId));
          if (input.deliveredAudio) {
            await this.ports.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`voice-heard:${record.callId}:${input.utteranceId}`),
              threadId: ThreadId.make(record.threadId),
              createdAt: now(),
              activity: {
                id: EventId.make(`voice-heard:${record.callId}:${input.utteranceId}`),
                kind: "call.playback.interrupted",
                summary:
                  "Voice reply interrupted. Only the recorded audio offsets were played; remaining text was not delivered.",
                tone: "info",
                payload: { callId: record.callId, deliveredAudio: input.deliveredAudio },
                turnId: null,
                createdAt: now(),
              },
            });
          }
          break;
      }
      return { call: await this.status(input.callId) };
    });
  }
  private async partial(input: CallRequest, signal: AbortSignal): Promise<SpeechResponse> {
    const record = await this.store.require(input.callId);
    const sessionId = lease(record);
    if (record.inputMode === "device") throw new Error("PC recognition is unavailable.");
    const rate = input.sampleRate!;
    const chunk = Buffer.from(input.audio!, "base64");
    if (
      !Number.isInteger(rate) ||
      rate < 8000 ||
      rate > 96000 ||
      !chunk.length ||
      chunk.length % 2 ||
      chunk.length > rate * 2 * 60
    )
      throw new Error("Invalid incremental PCM chunk.");
    const key = `${input.callId}:${input.utteranceId}`;
    const previous = this.partials.get(key);
    if (previous && previous.revision === input.revision) return previous.result;
    if (previous && (input.revision! < previous.revision || previous.sampleRate !== rate))
      throw new Error("Stale or incompatible transcript revision.");
    if (previous && !input.resetTranscript && input.revision !== previous.revision + 1)
      throw new Error("Missing incremental PCM chunk.");
    const pcm = Buffer.concat([
      input.resetTranscript ? Buffer.alloc(0) : (previous?.pcm ?? Buffer.alloc(0)),
      chunk,
    ]);
    if (pcm.length > rate * 2 * 60) throw new Error("Incremental recording exceeds one minute.");
    const result = this.ports
      .speech(
        {
          action: "transcribe",
          sessionId,
          audio: pcm.toString("base64"),
          sampleRate: rate,
          revision: input.revision,
        },
        signal,
      )
      .then((result) => {
        if (typeof result.text !== "string")
          throw new Error("Recognition returned no partial transcript.");
        return {
          text: result.text,
          revision: input.revision,
          transcriptFinal: result.transcriptFinal === true,
        };
      });
    this.partials.set(key, { revision: input.revision!, sampleRate: rate, pcm, result });
    return result;
  }
  private async close(callId: string) {
    for (const key of this.partials.keys())
      if (key.startsWith(`${callId}:`)) this.partials.delete(key);
    let found = false;
    const sessionId = await this.store.serial(callId, async () => {
      const record = await this.store.read<CallRecord>(callId, "call.json");
      if (!record) return;
      if (record.callId !== callId)
        throw new Error("Saved call identity does not match its archive.");
      found = true;
      await this.store.serial(`thread:${record.threadId}`, async () => {
        record.closed = true;
        await this.store.changed(record);
        await this.store.unbind(record.threadId, record.callId);
      });
      return record.lease;
    });
    if (sessionId) {
      // Expired or missing router leases must not prevent local call cleanup.
      await this.ports
        .speech({ action: "release", sessionId }, AbortSignal.timeout(90_000))
        .catch(() => {});
      await this.store.serial(callId, async () => {
        const record = await this.store.require(callId);
        if (record.lease === sessionId) {
          delete record.lease;
          delete record.leaseUntil;
          await this.store.changed(record);
        }
      });
    }
    return found;
  }
  private async open(input: CallRequest): Promise<SpeechResponse> {
    if (!input.options) throw new Error("Call options are required.");
    const previous = await this.store.read<CallRecord>(input.callId, "call.json");
    const bindingName = `${sha256(input.options.threadId)}.json`;
    if (!previous?.closed && (await this.store.activeCall(input.options.threadId, input.callId)))
      throw new Error("This chat already has a call. Resume it or end that call first.");
    if (previous) {
      if (
        JSON.stringify([previous.threadId, previous.modelSelection]) !==
        JSON.stringify([input.options.threadId, input.options.modelSelection])
      )
        throw new Error("Call ID already belongs to different options.");
      if (!previous.closed)
        await this.store.write("_threads", bindingName, { callId: input.callId });
      if (!previous.closed) {
        previous.lastClientAt = time();
        await this.store.write(input.callId, "call.json", previous);
        this.scheduleExpiry(
          input.callId,
          Math.min(
            previous.leaseUntil && previous.leaseUntil > time() ? previous.leaseUntil : Infinity,
            previous.lastClientAt + ABANDONED_CALL_MS,
          ),
        );
      }
      return { call: await this.status(input.callId) };
    }
    await this.ports.verify(input.options);
    if (this.operator && input.options.operatorSelection) {
      await this.ports.verifyVoice?.(input.options.modelSelection);
      await this.ports.verify({
        threadId: input.options.threadId,
        modelSelection: input.options.operatorSelection,
      });
      await this.operator.configure(input.options.threadId, {
        voice: input.options.modelSelection,
        operator: input.options.operatorSelection,
      });
    }
    const record: CallRecord = {
      ...input.options,
      callId: input.callId,
      createdAt: now(),
      lastClientAt: time(),
      version: "",
      closed: false,
      steps: ["Call log saved on PC", "Selected chat model and options configured"],
    };
    await this.store.write("_threads", bindingName, { callId: input.callId });
    await this.store.changed(record);
    this.scheduleExpiry(record.callId, record.lastClientAt! + ABANDONED_CALL_MS);
    await this.operator?.reopen(record.threadId, record.callId);
    return { call: await this.status(input.callId) };
  }
  private async prepare(
    callId: string,
    signal: AbortSignal,
    modelSelection?: CallOptions["modelSelection"],
    operatorSelection?: CallOptions["modelSelection"],
    preserveInputMode = false,
  ) {
    const record = await this.store.require(callId);
    active(record);
    await this.ports.verify({ ...record, modelSelection: modelSelection ?? record.modelSelection });
    if (this.operator && operatorSelection) {
      const voice = modelSelection ?? record.modelSelection;
      await this.ports.verifyVoice?.(voice);
      await this.ports.verify({ ...record, modelSelection: operatorSelection });
      await this.operator.configure(record.threadId, { voice, operator: operatorSelection });
    }
    const inputMode =
      record.inputMode === "device" || (preserveInputMode && record.inputMode)
        ? record.inputMode!
        : ((await this.ports.inputMode?.(signal)) ?? "pc");
    const tenants = inputMode === "device" ? [this.ports.tenants[1]] : [...this.ports.tenants];
    if (
      record.lease &&
      (record.leaseUntil ?? 0) > time() &&
      (record.inputMode ?? "pc") === inputMode
    ) {
      await this.renewLease(callId, signal);
      return;
    }
    if (record.lease) {
      await this.ports
        .speech({ action: "release", sessionId: record.lease }, AbortSignal.timeout(90_000))
        .catch(() => {});
      await this.store.serial(callId, async () => {
        const current = await this.store.require(callId);
        if (current.lease === record.lease) {
          delete current.lease;
          delete current.leaseUntil;
          await this.store.changed(current);
        }
      });
    }
    signal.throwIfAborted();
    active(await this.store.require(callId));
    // Keep receiving after HTTP cancellation so a late grant can be released below.
    const result = await this.ports.speech(
      { action: "acquire", tenants },
      AbortSignal.timeout(CALL_PREPARE_TIMEOUT_MS),
    );
    if (!result.sessionId) throw new Error("The router did not grant a speech lease.");
    if (
      !tenants.every((id) => result.tenants?.includes(id)) ||
      (inputMode === "device" && result.tenants?.some((id) => !tenants.includes(id)))
    ) {
      await this.ports.speech(
        { action: "release", sessionId: result.sessionId },
        AbortSignal.timeout(90_000),
      );
      throw new Error(
        inputMode === "device"
          ? "The router cannot grant a TTS-only speech profile. Device voice input is unavailable until the router supports it."
          : "Router speech tenants do not match the configured call profile. Ask the router owner to configure the STT and TTS tenants.",
      );
    }
    try {
      await this.store.serial(callId, async () => {
        const current = await this.store.require(callId);
        active(current);
        signal.throwIfAborted();
        current.lease = result.sessionId!;
        current.leaseUntil = expiry(result);
        current.inputMode = inputMode;
        current.steps = [
          ...current.steps.slice(0, 2),
          "Router granted the call profile; speech tenants ready",
        ];
        await this.store.changed(current);
        this.scheduleExpiry(
          callId,
          Math.min(current.leaseUntil!, (current.lastClientAt ?? time()) + ABANDONED_CALL_MS),
        );
      });
    } catch (error) {
      await this.ports.speech(
        { action: "release", sessionId: result.sessionId },
        AbortSignal.timeout(90_000),
      );
      throw error;
    }
  }
  private async renewLease(callId: string, signal: AbortSignal) {
    const record = await this.store.require(callId);
    const sessionId = lease(record);
    let until: number;
    try {
      until = expiry(await this.ports.speech({ action: "renew", sessionId }, signal));
    } catch (error) {
      await this.store.serial(callId, async () => {
        const current = await this.store.require(callId);
        if (current.lease === sessionId) {
          current.leaseUntil = 0;
          await this.store.changed(current);
        }
      });
      throw error;
    }
    await this.store.serial(callId, async () => {
      const current = await this.store.require(callId);
      if (!current.closed && current.lease === sessionId) {
        current.leaseUntil = until;
        await this.store.changed(current);
        this.scheduleExpiry(
          callId,
          Math.min(until, (current.lastClientAt ?? time()) + ABANDONED_CALL_MS),
        );
      }
    });
  }
  private async upload(record: CallRecord, input: CallRequest) {
    if (await this.store.read(record.callId, `${callIdentifier(input.utteranceId)}.typed.json`))
      throw new Error("This utterance ID already belongs to a typed turn.");
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
      input.audio.length > Math.ceil((rate * 2 * 60) / 3) * 4
    )
      throw new Error("Invalid PCM recording.");
    const audio = Buffer.from(input.audio, "base64");
    // Repeated base64 groups in a regexp exhaust the engine stack on long recordings.
    if (audio.toString("base64") !== input.audio) throw new Error("Invalid PCM recording.");
    if (!audio.length || audio.length % 2 || audio.length > rate * 2 * 60)
      throw new Error("Record up to one minute of speech per utterance.");
    const started = Date.parse(input.startedAt ?? "");
    const ended = Date.parse(input.endedAt ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started)
      throw new Error("Recording timestamps are required.");
    const hash = sha256(audio);
    const existing = await this.store.read<CallUtterance>(record.callId, `${id}.raw.json`);
    const intent = await this.store.read<CallUtterance>(record.callId, `${id}.upload.json`);
    const identity = existing ?? intent;
    if (identity) {
      if (
        identity.sha256 !== hash ||
        identity.sampleRate !== rate ||
        identity.startedAt !== input.startedAt ||
        identity.endedAt !== input.endedAt ||
        JSON.stringify(identity.modelSelection) !== JSON.stringify(input.modelSelection) ||
        JSON.stringify(identity.operatorSelection) !== JSON.stringify(input.operatorSelection)
      )
        throw new Error("Utterance ID already belongs to different audio or metadata.");
    }
    if (existing) {
      const retained = await NodeFSP.readFile(
        NodePath.join(this.store.directory(record.callId), `${id}.pcm`),
      );
      if (retained.length !== existing.bytes || sha256(retained) !== hash)
        throw new Error(
          "Saved recording failed its integrity check. Retain the archive for recovery.",
        );
      if (!record.recentUtterances?.includes(id)) {
        record.recentUtterances = [...(record.recentUtterances ?? []), id].slice(-64);
        await this.store.changed(record);
      }
      return this.store.utterance(record.callId, id);
    }
    const raw: CallUtterance = {
      id,
      sha256: hash,
      bytes: audio.length,
      sampleRate: rate,
      startedAt: input.startedAt!,
      endedAt: input.endedAt!,
      savedAt: now(),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.operatorSelection ? { operatorSelection: input.operatorSelection } : {}),
    };
    try {
      const orphan = await NodeFSP.readFile(
        NodePath.join(this.store.directory(record.callId), `${id}.pcm`),
      );
      if (sha256(orphan) !== hash)
        throw new Error("Utterance ID already has saved audio. It will not be overwritten.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!intent) await this.store.write(record.callId, `${id}.upload.json`, raw);
    await this.store.writeBytes(record.callId, `${id}.pcm`, audio);
    await this.store.write(record.callId, `${id}.raw.json`, raw);
    record.recentUtterances = [...(record.recentUtterances ?? []), id].slice(-64);
    await this.store.changed(record);
    return raw;
  }
  private async transcribe(record: CallRecord, id: string) {
    this.partials.delete(`${record.callId}:${id}`);
    const raw = await this.store.utterance(record.callId, id);
    if (raw.transcribedAt) return raw;
    if (record.inputMode === "device")
      throw new Error(
        "PC recognition is unavailable. Saved recordings are retained; use phone recognition or type to Otis.",
      );
    const audio = await NodeFSP.readFile(
      NodePath.join(this.store.directory(record.callId), `${id}.pcm`),
    );
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
    await this.store.serial(record.callId, async () =>
      this.store.changed(await this.store.require(record.callId)),
    );
    return this.store.utterance(record.callId, id);
  }
  private async deliver(record: CallRecord, id: string) {
    active(await this.store.require(record.callId));
    const utterance = await this.store.utterance(record.callId, id);
    if (utterance.deliveredAt) return utterance;
    if (utterance.retryOf) {
      const original = await this.store.read<{ deliveredAt?: string; messageId: string }>(
        utterance.retryOf.callId,
        `${utterance.retryOf.utteranceId}.delivery.json`,
      );
      if (original?.deliveredAt && original.messageId) {
        await this.store.write(record.callId, `${id}.delivery.json`, {
          deliveredAt: original.deliveredAt,
          messageId: original.messageId,
        });
        return this.store.utterance(record.callId, id);
      }
    }
    active(record);
    if (!utterance.transcribedAt || utterance.text === undefined)
      throw new Error("Save the transcript before delivery.");
    // Recovery changes the call and utterance IDs, but keeps the provider's deduplication identity.
    const messageId = `voice:${utterance.retryOf?.callId ?? record.callId}:${utterance.retryOf?.utteranceId ?? id}`;
    await this.store.write(record.callId, `${id}.delivery.json`, { messageId, preparedAt: now() });
    if (utterance.text.trim()) {
      let command = await this.store.read<
        Extract<OrchestrationCommand, { type: "thread.turn.start" }>
      >(record.callId, `${id}.dispatch.json`);
      if (!command) {
        const selection = utterance.modelSelection ?? record.modelSelection;
        const context = await this.ports.verify({ ...record, modelSelection: selection });
        const operatorSelection =
          utterance.operatorSelection ??
          record.operatorSelection ??
          (await this.operator?.read(record.threadId))?.models.operator;
        if (this.operator && operatorSelection) {
          await this.ports.verifyVoice?.(selection);
          await this.ports.verify({ ...record, modelSelection: operatorSelection });
          await this.operator.configure(record.threadId, {
            voice: selection,
            operator: operatorSelection,
          });
        }
        active(await this.store.require(record.callId));
        command = {
          type: "thread.turn.start",
          commandId: CommandId.make(messageId),
          threadId: ThreadId.make(record.threadId),
          message: {
            messageId: MessageId.make(messageId),
            role: "user",
            text: utterance.text,
            attachments: [],
          },
          modelSelection: selection,
          runtimeMode: context.runtimeMode,
          interactionMode: context.interactionMode,
          createdAt: utterance.savedAt,
        };
        await this.store.write(record.callId, `${id}.dispatch.json`, command);
      }
      if (
        JSON.stringify(command.modelSelection) !==
          JSON.stringify(utterance.modelSelection ?? record.modelSelection) ||
        command.threadId !== record.threadId ||
        command.message.messageId !== messageId ||
        command.message.text !== utterance.text
      )
        throw new Error("Saved voice delivery identity does not match its transcript.");
      await this.ports.dispatch(command);
    }
    const receipt = { deliveredAt: now(), messageId };
    if (utterance.retryOf)
      await this.store.write(
        utterance.retryOf.callId,
        `${utterance.retryOf.utteranceId}.delivery.json`,
        receipt,
      );
    await this.store.write(record.callId, `${id}.delivery.json`, receipt);
    await this.store.serial(record.callId, async () =>
      this.store.changed(await this.store.require(record.callId)),
    );
    return this.store.utterance(record.callId, id);
  }
  private async speak(
    record: CallRecord,
    input: CallRequest,
    signal: AbortSignal,
  ): Promise<SpeechResponse> {
    const request = await this.prepareSpeech(record, input);
    return request ? this.ports.speech(request, signal) : { played: true };
  }
  async *speakStream(input: CallRequest, signal: AbortSignal): AsyncGenerator<SpeechResponse> {
    await this.recoverExpirations();
    decodeCallRequest(input);
    if (input.action !== "call.speak") throw new Error("A speech request is required.");
    callIdentifier(input.callId);
    await this.contact(input.callId, signal);
    const request = await this.store.serial(
      `call.speak:${input.callId}:${callIdentifier(input.speechId)}`,
      async () => this.prepareSpeech(await this.store.require(input.callId), input),
    );
    if (!request) yield { played: true };
    else if (this.ports.speechStream) yield* this.ports.speechStream(request, signal);
    else yield await this.ports.speech(request, signal);
    yield { complete: true };
  }
  private async prepareSpeech(
    record: CallRecord,
    input: CallRequest,
  ): Promise<SpeechTransportRequest | undefined> {
    const id = callIdentifier(input.speechId);
    if (!input.text?.trim() || input.text.length > 1600) throw new Error("Invalid speech text.");
    const existing = await this.store.read<{ text: string }>(record.callId, `${id}.speech.json`);
    if (existing && existing.text !== input.text)
      throw new Error("Speech ID already belongs to different text.");
    if (await this.store.read(record.callId, `${id}.played.json`)) return undefined;
    if (!existing)
      await this.store.write(record.callId, `${id}.speech.json`, { text: input.text, at: now() });
    return {
      action: "speak",
      sessionId: lease(record),
      model: this.ports.ttsModel,
      text: input.text,
    };
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
