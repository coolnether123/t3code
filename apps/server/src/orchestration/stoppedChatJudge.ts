// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { Schema } from "effect";
import { authorityHash, isRequestedSaveReply, stoppedChatContext } from "./stoppedChatAuthority.ts";

export type StoppedChatInput = NonNullable<ReturnType<typeof stoppedChatContext>>;
const Decision = Schema.Struct({
  act: Schema.Boolean,
  verdict: Schema.String,
  intent: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  citation: Schema.optional(Schema.String),
  citation_message_id: Schema.optional(Schema.String),
  citation_at: Schema.optional(Schema.String),
  decision_id: Schema.optional(Schema.Number),
  continuation_receipt: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});
export type StoppedChatDecision = typeof Decision.Type;
const decodeDecision = Schema.decodeUnknownSync(Decision);
const decodeCredential = Schema.decodeUnknownSync(Schema.Struct({ agent: Schema.String }));
export type JudgeRequest = (url: string, init: RequestInit) => Promise<Response>;

const RequestedSave = Schema.Struct({
  status: Schema.String,
  message: Schema.optional(Schema.String),
  source_id: Schema.optional(Schema.String),
  citation: Schema.optional(Schema.String),
  citation_at: Schema.optional(Schema.String),
});
const decodeRequestedSave = Schema.decodeUnknownSync(RequestedSave);

/** One local Python boundary shares the Desktop matcher without a model or HTTP. */
export async function readRequestedSave(input: StoppedChatInput, home: string): Promise<unknown> {
  const script = NodePath.join(
    home,
    "Codex_Workroom/Projects/CodexDeck/hooks/requested_save_cli.py",
  );
  await NodeFSP.access(script);
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("/usr/bin/python3", [script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.stdin.on("error", reject);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("Requested-save matcher failed"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ question: input.question, humans: input.humans }));
  });
}

/** Local Deck owns the judge, spend accounting and business-action holds. */
export async function judgeStoppedChat(
  input: StoppedChatInput,
  threadId: string,
  baseDir: string,
  options: { home?: string; request?: JudgeRequest; requestedSave?: typeof readRequestedSave } = {},
): Promise<{ decision: StoppedChatDecision; text: string | null } | null> {
  const home = options.home ?? NodeOS.homedir();
  if (baseDir !== NodePath.join(home, ".t3")) return null;
  const root = NodePath.join(home, ".codexdeck");
  try {
    await NodeFSP.access(NodePath.join(root, "requested_save_t3_enabled"));
    const answer = decodeRequestedSave(
      await (options.requestedSave ?? readRequestedSave)(input, home),
    );
    const cited = input.humans.find(
      (human) =>
        human.id === answer.source_id &&
        human.text === answer.citation &&
        human.at === answer.citation_at,
    );
    if (
      answer.status === "yes" &&
      answer.message &&
      isRequestedSaveReply(answer.message) &&
      cited
    ) {
      return {
        text: answer.message,
        decision: {
          act: true,
          verdict: "requested_completion",
          intent: "yes",
          source: "requested_save",
          reason: "existing_chat_request",
          citation: cited.text,
          citation_message_id: cited.id,
          citation_at: cited.at,
        },
      };
    }
  } catch {
    // An unavailable local step leaves the existing JEV route intact.
  }
  try {
    await NodeFSP.access(NodePath.join(root, "jev_t3_enabled"));
  } catch {
    return null;
  }
  const machine = home.endsWith("/Users/millie")
    ? "millie"
    : home.endsWith("/Users/christinesmith")
      ? "elora"
      : "synthetic";
  if (!options.home && machine === "synthetic") return null;
  let token: string;
  try {
    const credentials: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "token"), "utf8"),
    );
    token = decodeCredential(credentials).agent;
  } catch {
    token = (await NodeFSP.readFile(NodePath.join(root, "agent_token"), "utf8")).trim();
  }
  if (!token) return null;
  const request = options.request ?? fetch;
  const response = await request("http://127.0.0.1:8787/api/v1/permission_check", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(55_000),
    headers: { "Content-Type": "application/json", "X-Deck-Token": token },
    body: JSON.stringify({
      machine,
      thread_id: threadId,
      turn_id: input.guard.expectedTurnId,
      question: input.question,
      christine_messages: input.humans,
      action_route: "unknown",
    }),
  });
  if (!response.ok) throw new Error(`Stopped-chat judge HTTP ${response.status}`);
  const decision = decodeDecision(await response.json());
  const cited = input.humans.find(
    (human) =>
      human.id === decision.citation_message_id &&
      human.text === decision.citation &&
      human.at === decision.citation_at,
  );
  let text: string | null = null;
  if (
    decision.act &&
    decision.verdict === "already_approved" &&
    decision.intent === "yes" &&
    cited &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(cited.at)
  ) {
    const stamp = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(Date.parse(cited.at));
    const action = /\b(?:should I|shall I|may I|can I|want me to)\s+([^?\n]+)\?\s*$/i
      .exec(input.question)?.[1]
      ?.replace(/[*_`]/g, "")
      .trim();
    text = `Yes, ${action && action.length <= 100 ? action : "go ahead with this exact action"}. I asked for this at ${stamp} already. (via JEV)`;
  }
  return { decision, text };
}

/** Private citation ledger records persisted messages separately from declined decisions. */
export async function recordStoppedChatDecision(
  row: Record<string, unknown> & { at: string },
  home = NodeOS.homedir(),
): Promise<void> {
  const directory = NodePath.join(home, ".codexdeck", "jev_hook_state");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const path = NodePath.join(
    directory,
    row.source === "requested_save"
      ? "requested_save_t3_deliveries.jsonl"
      : "jev_t3_deliveries.jsonl",
  );
  await NodeFSP.appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  await NodeFSP.chmod(path, 0o600);
}

export const stoppedChatCommandKey = (threadId: string, input: StoppedChatInput): string =>
  `stopped-chat:${authorityHash(JSON.stringify([threadId, input.guard]))}`;
