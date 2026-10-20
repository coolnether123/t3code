import type { CallCommand as OrchestrationCommand } from "./commands.ts";
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type CallModels,
  type ModelSelection,
  type OperatorUpdate,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderSession,
} from "@t3tools/contracts";
import { isToolLifecycleItemType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { callStore, sha256, type CallStore } from "./callStore.ts";
import {
  type OperatorChat,
  type OperatorJob,
  type OperatorLink,
  operatorPrompt,
  operatorUpdates,
  operatorCapacityFailure,
  voiceDelegation,
  VOICE_ROLE_PROMPT,
} from "./operatorProtocol.ts";

const now = () => DateTime.formatIso(Effect.runSync(DateTime.now));
const operatorRetryDelays = [1000, 2000, 4000] as const;
export const isCallLinkedSession = (id: string) => id.startsWith("t3-call-");
export interface OperatorPorts {
  context(threadId: string): Promise<{
    cwd: string;
    runtimeMode: ProviderSessionStartInput["runtimeMode"];
    interactionMode: "default" | "plan";
    conversation?: string;
    running?: boolean;
  }>;
  start(input: ProviderSessionStartInput): Promise<unknown>;
  send(input: ProviderSendTurnInput): Promise<unknown>;
  sessions(): Promise<readonly { threadId: string; status?: ProviderSession["status"] }[]>;
  dispatch(command: OrchestrationCommand): Promise<unknown>;
}

/** Links ordinary provider sessions to one visible chat. */
export class CallOperator {
  private ports: OperatorPorts | undefined;
  private tasks = new Set<Promise<unknown>>();
  private store: CallStore;
  private wait: (milliseconds: number) => Promise<void>;
  constructor(
    store: CallStore,
    wait = (milliseconds: number) => Effect.runPromise(Effect.sleep(milliseconds)),
  ) {
    this.store = store;
    this.wait = wait;
  }
  bind(ports: OperatorPorts) {
    this.ports = ports;
  }
  private file(threadId: string) {
    return `${sha256(threadId)}.operator.json`;
  }
  read(threadId: string) {
    return this.store.read<OperatorChat>("_operators", this.file(threadId));
  }
  private save(chat: OperatorChat) {
    return this.store.write("_operators", this.file(chat.threadId), chat);
  }
  async defaults() {
    return this.store.read<CallModels>("_operators", "default.models.json");
  }
  async configure(threadId: string, models: CallModels, saveDefault = false) {
    let revision: number | undefined;
    await this.store.serial(`operator:${threadId}`, async () => {
      const current = await this.read(threadId);
      if (JSON.stringify(current?.models) !== JSON.stringify(models))
        revision = (current?.modelRevision ?? 0) + 1;
      await this.save(
        current
          ? { ...current, models, ...(revision ? { modelRevision: revision } : {}) }
          : {
              threadId,
              models,
              modelRevision: 1,
              links: [],
              jobs: [],
              updates: [],
              voices: [],
              requests: {},
            },
      );
      if (saveDefault) await this.store.write("_operators", "default.models.json", models);
    });
    if (revision && this.ports) {
      const at = now();
      const id = `call-models:${sha256(threadId)}:${revision}`;
      await this.ports.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(threadId),
        activity: {
          id: EventId.make(id),
          kind: "call.models.changed",
          summary: `Voice: ${models.voice.model}. Background agent: ${models.operator.model}.`,
          tone: "info",
          payload: { models },
          turnId: null,
          createdAt: at,
        },
        createdAt: at,
      });
    }
    return models;
  }
  private async change(
    threadId: string,
    work: (chat: MutableChat) => void | Promise<void>,
    notify = true,
  ) {
    const chat = await this.store.serial(`operator:${threadId}`, async () => {
      const chat = structuredClone(await this.read(threadId)) as MutableChat | undefined;
      if (!chat) throw new Error("Configure both call models first.");
      await work(chat);
      await this.save(chat);
      return chat;
    });
    if (notify) {
      const call = await this.store.activeCall(threadId, "");
      if (call)
        await this.store.serial(call.callId, async () =>
          this.store.changed(await this.store.require(call.callId)),
        );
    }
    return chat;
  }
  private background(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  async drain() {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }
  private requirePorts() {
    if (!this.ports) throw new Error("Call sessions are not connected to the provider runtime.");
    return this.ports;
  }
  async link(threadId: string, role: OperatorLink["role"], selection: ModelSelection) {
    const sessionId = `t3-call-${role}-${sha256(JSON.stringify([threadId, selection])).slice(0, 48)}`;
    const link: OperatorLink = { sessionId, threadId, role, selection };
    await this.change(threadId, (chat) => {
      if (!chat.links.some((entry) => entry.sessionId === sessionId)) chat.links.push(link);
    });
    await this.store.write("_operatorLinks", `${sha256(sessionId)}.link.json`, link);
    return link;
  }
  async findLink(sessionId: string) {
    return isCallLinkedSession(sessionId)
      ? this.store.read<OperatorLink>("_operatorLinks", `${sha256(sessionId)}.link.json`)
      : undefined;
  }
  private async ensure(link: OperatorLink) {
    const ports = this.requirePorts();
    if (
      (await ports.sessions()).some(
        (session) =>
          session.threadId === link.sessionId &&
          session.status !== "error" &&
          session.status !== "closed",
      )
    )
      return;
    const context = await ports.context(link.threadId);
    await ports.start({
      threadId: ThreadId.make(link.sessionId),
      providerInstanceId: link.selection.instanceId,
      modelSelection: link.selection,
      cwd: context.cwd,
      runtimeMode: context.runtimeMode,
      ...(link.role === "voice" ? { toolMode: "none" as const } : {}),
    });
  }
  async voice(input: {
    threadId: string;
    messageId: string;
    text: string;
    selection: ModelSelection;
  }) {
    return this.store.serial(`voice:${input.threadId}`, () => this.sendVoice(input));
  }
  private async sendVoice(input: {
    threadId: string;
    messageId: string;
    text: string;
    selection: ModelSelection;
  }) {
    const chat = await this.read(input.threadId);
    if (!chat) return false;
    const existing = chat.voices.find((voice) => voice.id === input.messageId);
    if (existing?.accepted || existing?.turnId) return true;
    if (chat.voices.some((voice) => voice.id !== input.messageId && !voice.finished))
      throw new Error("The previous voice turn is still active. Retry after it finishes.");
    const announcement = input.messageId.startsWith("voice-update:")
      ? chat.updates.filter((update) => update.announcementId === input.messageId)
      : undefined;
    if (announcement && !announcement.length)
      throw new Error("The voice announcement has no saved operator updates.");
    const text = announcement
      ? `At this pause, tell Jared these completed results or questions in one short natural reply. For needs-Jared, ask the question or explain what is needed. Do not delegate these updates back to the operator.\n${JSON.stringify(announcement.map(({ status, text }) => ({ status, text })))}`
      : input.text;
    const link = await this.link(input.threadId, "voice", input.selection);
    await this.ensure(link);
    const context = await this.requirePorts().context(input.threadId);
    await this.change(input.threadId, (current) => {
      const pending = {
        id: input.messageId,
        exactWords: input.text,
        sessionId: link.sessionId,
        operator: current.models.operator,
        ...(context.conversation ? { context: context.conversation } : {}),
        finished: false,
        accepted: false,
      };
      const previous = current.voices.find((voice) => voice.id === input.messageId);
      if (previous) Object.assign(previous, pending);
      else current.voices.push(pending);
    });
    try {
      await this.requirePorts().send({
        threadId: ThreadId.make(link.sessionId),
        messageId: input.messageId,
        modelSelection: link.selection,
        input: `${VOICE_ROLE_PROMPT}\n\nRecent conversation:\n${context.conversation ?? ""}\n\nOperator receipts:\n${JSON.stringify(chat.updates.slice(-20).map(({ status, text }) => ({ status, text })))}\n\n${announcement ? "Operator update at this pause" : "Jared's message"}:\n${text}`,
      });
      await this.change(input.threadId, (current) => {
        current.voices.find((voice) => voice.id === input.messageId)!.accepted = true;
      });
    } catch (error) {
      await this.change(input.threadId, (current) => {
        const voice = current.voices.find((voice) => voice.id === input.messageId)!;
        if (!voice.accepted && !voice.turnId) voice.finished = true;
      });
      throw error;
    }
    return true;
  }
  async requestSession(threadId: string, requestId: string) {
    return (await this.read(threadId))?.requests[requestId];
  }
  async voiceSession(threadId: string) {
    return (await this.read(threadId))?.voices.findLast((voice) => !voice.finished)?.sessionId;
  }
  async update(
    threadId: string,
    jobId: string,
    id: string,
    status: OperatorUpdate["status"],
    text: string,
  ) {
    const update: OperatorUpdate = { id, jobId, status, text, createdAt: now() };
    await this.change(threadId, (chat) => {
      if (!chat.updates.some((entry) => entry.id === id)) chat.updates.push(update);
    });
    await this.requirePorts().dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`call-status:${id}`),
      threadId: ThreadId.make(threadId),
      activity: {
        id: EventId.make(`call-status:${id}`),
        kind: "call.operator.status",
        summary: `Background agent: ${status}. ${text}`,
        tone: status === "needs-Jared" ? "approval" : "info",
        payload: { ...update, source: "operator" },
        turnId: null,
        createdAt: update.createdAt,
      },
      createdAt: update.createdAt,
    });
  }
  async event(event: ProviderRuntimeEvent, assistantText?: string) {
    const link = await this.findLink(event.threadId);
    if (!link) return undefined;
    const chat = await this.read(link.threadId);
    if (!chat) throw new Error("Call session lost its owning chat.");
    if (link.role === "voice") return this.voiceEvent(link, chat, event, assistantText);
    return this.operatorEvent(link, chat, event);
  }
  private async voiceEvent(
    link: OperatorLink,
    chat: OperatorChat,
    event: ProviderRuntimeEvent,
    assistantText?: string,
  ) {
    if (event.type === "turn.started" && event.turnId) {
      const voice = chat.voices.findLast(
        (entry) => entry.sessionId === link.sessionId && !entry.finished,
      );
      if (voice && !voice.turnId)
        await this.change(link.threadId, (current) => {
          current.voices.find((entry) => entry.id === voice.id)!.turnId = event.turnId;
          current.voices.find((entry) => entry.id === voice.id)!.accepted = true;
          for (const update of current.updates)
            if (update.announcementId === voice.id) update.announcementTurnId = event.turnId;
        });
    }
    if (event.type === "turn.completed" || event.type === "runtime.error") {
      const voice = chat.voices.find(
        (entry) =>
          entry.sessionId === link.sessionId &&
          !entry.finished &&
          (event.turnId === undefined || entry.turnId === event.turnId),
      );
      if (voice) {
        let intent: string | undefined;
        try {
          if (
            event.type === "turn.completed" &&
            event.payload.state === "completed" &&
            !/<otis-hold\s*\/?[>\s]/.test(assistantText ?? "") &&
            !voice.id.startsWith("voice-update:")
          )
            intent = voiceDelegation(assistantText ?? "")?.intent;
        } catch {
          await this.update(
            link.threadId,
            voice.id,
            `${voice.id}:invalid`,
            "needs-Jared",
            "The voice handoff was invalid. Please repeat the request.",
          );
        }
        await this.change(link.threadId, (current) => {
          const entry = current.voices.find((entry) => entry.id === voice.id)!;
          entry.finished = true;
          if (intent && !current.jobs.some((job) => job.id === voice.id))
            current.jobs.push({
              id: voice.id,
              exactWords: voice.exactWords,
              intent,
              ...(voice.context ? { context: voice.context } : {}),
              selection: voice.operator,
              phase: "queued",
            });
        });
        this.background(this.kick(link.threadId));
      }
    }
    return link;
  }
  private async operatorEvent(link: OperatorLink, chat: OperatorChat, event: ProviderRuntimeEvent) {
    if (
      event.turnId &&
      chat.jobs.some(
        (entry) =>
          entry.sessionId === link.sessionId &&
          (entry.retiredTurnIds?.includes(event.turnId!) ||
            (entry.phase === "done" && entry.turnId === event.turnId)),
      )
    )
      return link;
    const job = chat.jobs.find(
      (entry) =>
        entry.sessionId === link.sessionId &&
        (entry.phase === "running" || entry.phase === "sending" || entry.phase === "uncertain") &&
        (!entry.turnId || entry.turnId === event.turnId),
    );
    if (!job) return link;
    if (event.type === "turn.started" && event.turnId && !job.turnId)
      await this.change(link.threadId, (current) => {
        current.jobs.find((entry) => entry.id === job.id)!.turnId = event.turnId;
      });
    if (event.type === "item.started" && isToolLifecycleItemType(event.payload.itemType))
      await this.update(
        link.threadId,
        job.id,
        `${event.eventId}:progress`,
        "progress",
        event.payload.title ?? "The background agent started a tool.",
      );
    if (
      (event.type === "request.opened" || event.type === "user-input.requested") &&
      event.requestId
    ) {
      await this.change(link.threadId, (current) => {
        current.requests[event.requestId!] = link.sessionId;
      });
      await this.update(
        link.threadId,
        job.id,
        `${event.eventId}:waiting`,
        "needs-Jared",
        "The background agent needs a response in this chat.",
      );
    }
    if (
      event.type === "item.completed" &&
      event.payload.itemType === "assistant_message" &&
      event.payload.detail
    ) {
      await this.operatorReply(link, job, event.eventId, event.payload.detail);
    }
    if (event.type === "turn.completed" || event.type === "runtime.error")
      await this.finishOperator(link, job, event);
    return link;
  }
  private async operatorReply(link: OperatorLink, job: OperatorJob, eventId: string, text: string) {
    try {
      for (const [index, update] of operatorUpdates(text).entries()) {
        if (update.status === "done")
          await this.change(link.threadId, (current) => {
            current.jobs.find((entry) => entry.id === job.id)!.result = update.text;
          });
        else
          await this.update(
            link.threadId,
            job.id,
            `${eventId}:${index}`,
            update.status,
            update.text,
          );
      }
    } catch {
      await this.update(
        link.threadId,
        job.id,
        `${eventId}:invalid`,
        "needs-Jared",
        "The background agent returned an invalid status. Its activity is available in the chat.",
      );
    }
  }
  private async finishOperator(
    link: OperatorLink,
    job: OperatorJob,
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "runtime.error" }>,
  ) {
    const latest = await this.read(link.threadId);
    const completedJob = latest?.jobs.find((entry) => entry.id === job.id);
    if (
      !completedJob ||
      !["running", "sending", "uncertain"].includes(completedJob.phase) ||
      (completedJob.retryCount ?? 0) !== (job.retryCount ?? 0)
    )
      return;
    const succeeded = event.type === "turn.completed" && event.payload.state === "completed";
    const capacityFailure = operatorCapacityFailure(event);
    const retryCount = completedJob?.retryCount ?? 0;
    const delay = operatorRetryDelays[retryCount];
    if (capacityFailure && delay !== undefined) {
      let claimed = false;
      await this.change(link.threadId, (current) => {
        const entry = current.jobs.find((entry) => entry.id === job.id)!;
        if (
          !["running", "sending", "uncertain"].includes(entry.phase) ||
          (entry.retryCount ?? 0) !== (job.retryCount ?? 0)
        )
          return;
        entry.phase = "retrying";
        entry.retryCount = retryCount + 1;
        entry.retiredTurnIds = [
          ...new Set([
            ...(entry.retiredTurnIds ?? []),
            ...(event.turnId ? [event.turnId] : []),
            ...(entry.turnId ? [entry.turnId] : []),
          ]),
        ];
        delete entry.turnId;
        delete entry.result;
        claimed = true;
      });
      if (claimed) {
        await this.update(
          link.threadId,
          job.id,
          `${job.id}:retry:${retryCount + 1}`,
          "progress",
          `The selected model is busy. Retrying in ${delay / 1000} ${delay === 1000 ? "second" : "seconds"}, retry ${retryCount + 1} of ${operatorRetryDelays.length}.`,
        );
        this.background(this.retryOperator(link.threadId, job.id, retryCount + 1, delay));
      }
      return;
    }
    if (succeeded && completedJob?.result)
      await this.update(
        link.threadId,
        job.id,
        `${event.eventId}:result`,
        "done",
        completedJob.result,
      );
    else if (
      !succeeded ||
      !latest?.updates.some((update) => update.jobId === job.id && update.status === "needs-Jared")
    ) {
      await this.update(
        link.threadId,
        job.id,
        `${event.eventId}:result`,
        "needs-Jared",
        capacityFailure
          ? "The selected model is still at capacity after three retries. Try again later or choose a different background model."
          : "The background turn ended without a verified result. Check its activity.",
      );
    }
    await this.change(link.threadId, (current) => {
      current.jobs.find((entry) => entry.id === job.id)!.phase = "done";
    });
    this.background(this.kick(link.threadId));
  }
  private async retryOperator(threadId: string, jobId: string, retryCount: number, delay: number) {
    await this.wait(delay);
    await this.change(threadId, (current) => {
      const entry = current.jobs.find((entry) => entry.id === jobId)!;
      if (entry.phase === "retrying" && entry.retryCount === retryCount) entry.phase = "queued";
    });
    await this.kick(threadId);
  }
  async kick(threadId: string) {
    const chat = await this.read(threadId);
    if (
      !chat ||
      chat.jobs.some(
        (job) =>
          job.phase === "running" ||
          job.phase === "sending" ||
          job.phase === "uncertain" ||
          job.phase === "retrying",
      )
    )
      return;
    const job = chat.jobs.find((job) => job.phase === "queued");
    if (!job) return;
    const link = await this.link(threadId, "operator", job.selection);
    let claimed = false;
    await this.change(threadId, (current) => {
      if (
        current.jobs.some((entry) =>
          ["running", "sending", "uncertain", "retrying"].includes(entry.phase),
        )
      )
        return;
      const entry = current.jobs.find((entry) => entry.id === job.id)!;
      entry.phase = "sending";
      entry.sessionId = link.sessionId;
      claimed = true;
    });
    if (!claimed) return;
    try {
      await this.ensure(link);
      await this.requirePorts().send({
        threadId: ThreadId.make(link.sessionId),
        messageId: job.retryCount ? `${job.id}:retry:${job.retryCount}` : job.id,
        modelSelection: job.selection,
        input: operatorPrompt(job),
      });
      await this.change(threadId, (current) => {
        const entry = current.jobs.find((entry) => entry.id === job.id)!;
        if (entry.phase === "sending") entry.phase = "running";
      });
      await this.update(
        threadId,
        job.id,
        `${job.id}:started`,
        "started",
        "The background agent received the request.",
      );
    } catch {
      let uncertain = false;
      await this.change(threadId, (current) => {
        const entry = current.jobs.find((entry) => entry.id === job.id)!;
        if (entry.phase === "sending" && (entry.retryCount ?? 0) === (job.retryCount ?? 0)) {
          entry.phase = "uncertain";
          uncertain = true;
        }
      });
      if (!uncertain) return;
      await this.update(
        threadId,
        job.id,
        `${job.id}:uncertain`,
        "needs-Jared",
        "Background delivery could not be confirmed. Check activity before retrying.",
      );
    }
  }
  async announce(threadId: string, callId: string) {
    const chat = await this.read(threadId);
    const updates =
      chat?.updates.filter(
        (update) =>
          !update.heardAt &&
          !update.announcementId &&
          (update.status === "done" || update.status === "needs-Jared"),
      ) ?? [];
    if (!chat || !updates.length || chat.voices.some((voice) => !voice.finished)) return false;
    const id = `voice-update:${callId}:${sha256(updates.map((update) => update.id).join()).slice(0, 24)}`;
    const context = await this.requirePorts().context(threadId);
    if (context.running) return false;
    await this.change(threadId, (current) => {
      for (const update of current.updates)
        if (updates.some((entry) => entry.id === update.id)) update.announcementId = id;
    });
    try {
      await this.requirePorts().dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(threadId),
        message: {
          messageId: MessageId.make(id),
          role: "user",
          text: "Background update ready.",
          attachments: [],
        },
        modelSelection: chat.models.voice,
        runtimeMode: context.runtimeMode,
        interactionMode: "default",
        createdAt: now(),
      });
    } catch (error) {
      await this.change(threadId, (current) => {
        const voice = current.voices.find((voice) => voice.id === id);
        if (voice?.accepted || voice?.turnId) return;
        for (const update of current.updates) {
          if (update.announcementId !== id) continue;
          delete update.announcementId;
          delete update.announcementTurnId;
        }
      });
      throw error;
    }
    return true;
  }
  async reopen(threadId: string, callId: string) {
    if (!(await this.read(threadId))) return;
    await this.change(
      threadId,
      (chat) => {
        for (const update of chat.updates)
          if (
            !update.heardAt &&
            update.announcementId &&
            !update.announcementId.startsWith(`voice-update:${callId}:`)
          ) {
            delete update.announcementId;
            delete update.announcementTurnId;
          }
      },
      false,
    );
  }
  async heard(threadId: string, ids: readonly string[]) {
    await this.change(threadId, (chat) => {
      for (const update of chat.updates) if (ids.includes(update.id)) update.heardAt = now();
    });
    const at = now();
    const id = `call-heard:${sha256(JSON.stringify(ids))}`;
    await this.requirePorts().dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(id),
      threadId: ThreadId.make(threadId),
      activity: {
        id: EventId.make(id),
        kind: "call.operator.heard",
        summary: "Operator update heard",
        tone: "info",
        payload: { updateIds: ids },
        turnId: null,
        createdAt: at,
      },
      createdAt: at,
    });
  }
}
type MutableChat = {
  -readonly [K in keyof OperatorChat]: K extends "links"
    ? OperatorLink[]
    : K extends "jobs"
      ? MutableJob[]
      : K extends "updates"
        ? MutableUpdate[]
        : K extends "voices"
          ? MutableVoice[]
          : K extends "requests"
            ? Record<string, string>
            : OperatorChat[K];
};
type MutableJob = { -readonly [K in keyof OperatorJob]: OperatorJob[K] };
type MutableUpdate = { -readonly [K in keyof OperatorUpdate]: OperatorUpdate[K] };
type MutableVoice = {
  -readonly [K in keyof OperatorChat["voices"][number]]: OperatorChat["voices"][number][K];
};
const operators = new Map<string, CallOperator>();
export function callOperator(stateDir: string) {
  let value = operators.get(stateDir);
  if (!value) {
    value = new CallOperator(callStore(stateDir));
    operators.set(stateDir, value);
  }
  return value;
}
