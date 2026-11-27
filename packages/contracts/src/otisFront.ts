// Otis: integration/services/otis-front/contract.ts @ 7ce991f1
// Otis Front Door v1: the wire contract between Otis and every front-door client.
//
// Source of truth: Otis repo, integration/services/otis-front/contract.ts.
// Design: Artifacts/otis-window-20261125/spec.md section 1 (plus the 11-25
// addendum on how Otis #1 is reached).
//
// Clients copy this file verbatim. T3 keeps it at packages/contracts/src/otisFront.ts
// with a header naming this path and the Otis commit it came from. Both repos
// decode fixtures/front-events.ndjson and fixtures/front-bodies.json in their
// checks, so the copies can't drift silently. Edit here first, then re-copy.
//
// Stability rules (spec 1.7):
// - v1 fields are never removed or renamed. A new field is added as
//   S.optionalKey so older payloads still decode. Breaking changes get /api/v2/front.
// - Unknown event types decode as UnknownFrontEvent and are ignored by clients.
// - Card kinds are open strings. An unknown kind renders with the generic card.
// - Closed literal sets (states, tones, channels, statuses) are part of v1. A new
//   value would fail older decoders, so add a new optional field instead of a
//   new literal. Open sets are plain strings on purpose.
// - Unknown object keys are stripped on decode (Effect's default), so a newer
//   server never breaks an older client.
//
// Every schema here is plain JSON: the decoded type equals the encoded type, so
// encode(decode(x)) returns x for any payload without unknown keys.
//
// Keep this file free of imports other than effect/Schema, and of syntax that
// Node's type stripping can't erase (no enums, namespaces or parameter properties).

import * as S from "effect/Schema";

// ---------------------------------------------------------------------------
// Constants

export const FRONT_API_VERSION = 1;
export const FRONT_API_BASE = "/api/v1/front";

export const KNOWN_EVENT_TYPES = ["state", "reset", "item", "reply.delta", "speak", "report"] as const;
/** Kinds the server emits today. Clients may style these; every other kind uses the generic card. */
export const KNOWN_CARD_KINDS = ["handoff", "work", "ask", "receipt", "report"] as const;

export const OTIS1_STATES = ["working", "listening", "idle-unreachable", "unknown"] as const;
export const WORKING_STATES = ["running", "starting", "queued"] as const;
export const ITEM_SENDERS = ["jared", "otis", "otis-1"] as const;
export const CHANNELS = ["typed", "voice"] as const;
export const ITEM_STATUSES = ["streaming", "done", "interrupted", "failed"] as const;
export const BASIS_KINDS = ["read", "conversation", "guess", "none"] as const;
export const TONES = ["neutral", "good", "warn", "bad"] as const;
export const SPEAK_PRIORITIES = ["now", "next-pause"] as const;

// ---------------------------------------------------------------------------
// Primitives

/** Opaque, non-empty id. Clients never parse ids; they URL-encode them in paths. */
export const Id = S.String.check(S.isMinLength(1));
const Seq = S.Int.check(S.isGreaterThanOrEqualTo(0));
const Count = S.Int.check(S.isGreaterThanOrEqualTo(0));
/** ISO 8601 date-time with an explicit zone ("Z" or an offset). */
export const IsoTime = S.String.check(
  S.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/),
);
/**
 * Link target. `otis://node/<nodeId>` and `otis://task/<taskId>` today; T3 maps
 * otis://node/... to /_chat/otis/node/$nodeId. A client shows an otis:// kind it
 * doesn't know as plain text. Web links are https only.
 */
export const Href = S.String.check(S.isPattern(/^(otis:\/\/[a-z][a-z-]*\/\S+|https:\/\/\S+)$/));
const NonBlank = S.String.check(S.makeFilter((s: string) => s.trim().length > 0 || "must not be blank"));

// ---------------------------------------------------------------------------
// Actions and cards (spec 1.6)

/**
 * A server-defined button. The client posts POST /actions/{id}. When `confirm` is
 * set it asks first with that text; when `input` is set it asks for one line of
 * text with that prompt and sends it as `input`.
 */
export const Action = S.Struct({
  id: Id,
  label: NonBlank,
  confirm: S.NullOr(S.String),
  input: S.NullOr(S.String),
});
export type Action = typeof Action.Type;

export const CardStatus = S.Struct({
  label: NonBlank,
  tone: S.Literals(TONES),
});
export type CardStatus = typeof CardStatus.Type;

export const CardLine = S.Struct({
  label: S.NullOr(S.String),
  text: S.String,
  href: S.NullOr(Href),
});
export type CardLine = typeof CardLine.Type;

/** Every kind renders through one generic layout: title, status, lines, actions. */
export const Card = S.Struct({
  id: Id,
  kind: NonBlank,
  title: S.String,
  status: S.NullOr(CardStatus),
  lines: S.Array(CardLine),
  actions: S.Array(Action),
  updatedAt: IsoTime,
});
export type Card = typeof Card.Type;

// ---------------------------------------------------------------------------
// Conversation (spec 1.6, section 3)

export const BasisRead = S.Struct({
  id: Id, // "r1", "r2", ... unique within the turn
  source: NonBlank, // the read name, e.g. "work", "task", "mail"
  observedAt: IsoTime,
});
export type BasisRead = typeof BasisRead.Type;

/** What a reply's facts rest on. Server-checked before anything is shown or spoken. */
export const Basis = S.Struct({
  kind: S.Literals(BASIS_KINDS),
  reads: S.Array(BasisRead),
});
export type Basis = typeof Basis.Type;

export const ConversationItem = S.Struct({
  id: Id,
  at: IsoTime,
  from: S.Literals(ITEM_SENDERS),
  /** How Jared's turn arrived, or how an Otis reply was delivered. Null for unsolicited items. */
  channel: S.NullOr(S.Literals(CHANNELS)),
  status: S.Literals(ITEM_STATUSES),
  /**
   * The turn this item belongs to (Jared's turn and the reply to it share it).
   * Lets any client Stop a streaming reply it didn't start. Null for items no
   * turn produced, such as an Otis #1 update or a report.
   */
  turnId: S.NullOr(Id),
  /** Plain text; light markdown (links, `code`, lists) allowed. Never contains control blocks. */
  text: S.String,
  /** Null for Jared's items, and for Otis items while still streaming. */
  basis: S.NullOr(Basis),
  cards: S.Array(Card),
});
export type ConversationItem = typeof ConversationItem.Type;

// ---------------------------------------------------------------------------
// FrontState (spec 1.4)

export const WaitingItem = S.Struct({
  id: Id,
  lane: NonBlank,
  title: S.String,
  since: IsoTime,
  actions: S.Array(Action),
  nodeId: S.NullOr(Id),
});
export type WaitingItem = typeof WaitingItem.Type;

export const WorkingItem = S.Struct({
  nodeId: Id,
  lane: NonBlank,
  title: S.String,
  model: NonBlank, // short form for dense rows, e.g. "Sol", "Opus 5.5"
  effort: S.NullOr(S.String), // null = not reported
  state: S.Literals(WORKING_STATES),
  startedAt: IsoTime,
  costUsd: S.NullOr(S.Finite),
});
export type WorkingItem = typeof WorkingItem.Type;

export const Otis1State = S.Struct({
  /**
   * working: a lane UserPromptSubmit without a later Stop.
   * listening: idle, and a handoff would wake it now (by `reachVia`).
   * idle-unreachable: idle and nothing would wake it; handoffs queue.
   * unknown: no receipt to tell.
   */
  state: S.Literals(OTIS1_STATES),
  /**
   * How a handoff reaches Otis #1 right now, as display text, e.g.
   * "message pipe", "parent feed waiter", "T3 thread". Null when unreachable
   * or unknown. Clients show it; they never branch on it.
   */
  reachVia: S.NullOr(S.String),
  model: NonBlank, // "Opus 5.5"
  effort: S.NullOr(S.String), // null: the UI says "effort not reported"
  contextTokens: S.NullOr(Count),
  contextLimit: S.NullOr(Count),
  activeHandoffs: Count,
});
export type Otis1State = typeof Otis1State.Type;

export const TalkerState = S.Struct({
  model: NonBlank, // "Haiku 5.5"
  effort: S.String, // "low"
});
export type TalkerState = typeof TalkerState.Type;

export const ReportPointer = S.Struct({
  reportId: Id,
  heard: S.Boolean,
  window: S.String, // display text, e.g. "11:40 PM to 9:05 AM"
});
export type ReportPointer = typeof ReportPointer.Type;

export const FrontState = S.Struct({
  seq: Seq,
  observedAt: IsoTime,
  otis1: Otis1State,
  talker: TalkerState,
  waiting: S.Array(WaitingItem), // oldest first
  working: S.Array(WorkingItem),
  report: S.NullOr(ReportPointer),
});
export type FrontState = typeof FrontState.Type;

// ---------------------------------------------------------------------------
// Events (spec 1.5). GET /events?after=<seq> streams one JSON object per line.

export const StateEvent = S.Struct({ seq: Seq, type: S.Literal("state"), state: FrontState });
export const ResetEvent = S.Struct({ seq: Seq, type: S.Literal("reset") });
/** New or replaced item. Same id = replace in place (cards update without new rows). */
export const ItemEvent = S.Struct({ seq: Seq, type: S.Literal("item"), item: ConversationItem });
/** Appends text to a streaming item. */
export const ReplyDeltaEvent = S.Struct({
  seq: Seq,
  type: S.Literal("reply.delta"),
  itemId: Id,
  text: S.String,
});
/** For clients with a call open: say this aloud. Clients without a call ignore it. */
export const SpeakEvent = S.Struct({
  seq: Seq,
  type: S.Literal("speak"),
  itemId: Id,
  text: NonBlank,
  priority: S.Literals(SPEAK_PRIORITIES),
});
/** A new morning report exists; fetch it with GET /reports/morning/latest. */
export const ReportEvent = S.Struct({ seq: Seq, type: S.Literal("report"), reportId: Id });

/** Every event type v1 defines. Decoding a malformed known event fails. */
export const FrontEvent = S.Union([
  StateEvent,
  ResetEvent,
  ItemEvent,
  ReplyDeltaEvent,
  SpeakEvent,
  ReportEvent,
]);
export type FrontEvent = typeof FrontEvent.Type;

const knownEventType = new Set<string>(KNOWN_EVENT_TYPES);
/** An event type from a newer server. Only seq and type are kept; clients skip it. */
export const UnknownFrontEvent = S.Struct({
  seq: Seq,
  type: S.String.check(
    S.makeFilter((type: string) => !knownEventType.has(type) || `"${type}" is a known event type`),
  ),
});
export type UnknownFrontEvent = typeof UnknownFrontEvent.Type;

/** What a stream line decodes to. Use this, not FrontEvent, when reading the stream. */
export const FrontStreamEvent = S.Union([FrontEvent, UnknownFrontEvent]);
export type FrontStreamEvent = typeof FrontStreamEvent.Type;

export const isKnownFrontEvent = (event: FrontStreamEvent): event is FrontEvent =>
  knownEventType.has(event.type);

const decodeStreamEvent = S.decodeUnknownSync(FrontStreamEvent);
/** Parse and decode one NDJSON line. Throws on malformed JSON or a malformed known event. */
export const decodeFrontStreamLine = (line: string): FrontStreamEvent =>
  decodeStreamEvent(JSON.parse(line));

// ---------------------------------------------------------------------------
// Morning report (spec section 5). Items are Cards so any client renders them
// generically; the server owns what each section means and how it's grouped.

export const ReportSection = S.Struct({
  /** "went-wrong", "done", "next", "needs-you" today; open set. */
  id: NonBlank,
  title: S.String, // "What went wrong, and what we learned"
  items: S.Array(Card),
  /** Shown when items is empty, e.g. "Nothing broke." Null hides an empty section. */
  empty: S.NullOr(S.String),
});
export type ReportSection = typeof ReportSection.Type;

export const MorningReport = S.Struct({
  reportId: Id,
  builtAt: IsoTime,
  window: S.Struct({ from: IsoTime, to: IsoTime }),
  /** Display text for the collapsed card and phone strip. */
  title: S.String, // "Overnight"
  windowLabel: S.String, // "11:40 PM to 9:05 AM"
  summary: S.String, // "2 went wrong · 4 done · 1 needs you"
  sections: S.Array(ReportSection), // in display order
  /** What Play says, once generated; null until then. */
  script: S.NullOr(S.String),
  heardAt: S.NullOr(IsoTime),
});
export type MorningReport = typeof MorningReport.Type;

// ---------------------------------------------------------------------------
// HTTP bodies (spec 1.3). Paths are relative to FRONT_API_BASE.

/** POST /turns. Re-posting the same clientTurnId returns the same turnId (retry after a lost response). */
export const TurnRequest = S.Struct({
  clientTurnId: Id,
  channel: S.Literals(CHANNELS),
  text: NonBlank,
  attachments: S.optionalKey(S.Array(Id)), // accepted, unused in phase 1
});
export type TurnRequest = typeof TurnRequest.Type;

export const TurnAccepted = S.Struct({ turnId: Id });
export type TurnAccepted = typeof TurnAccepted.Type;

/** POST /turns/{turnId}/cancel. cancelled is false when the reply had already finished. */
export const TurnCancelled = S.Struct({ turnId: Id, cancelled: S.Boolean });
export type TurnCancelled = typeof TurnCancelled.Type;

/** POST /actions/{actionId}. requestId makes a retried press idempotent. */
export const ActionRequest = S.Struct({
  requestId: Id,
  input: S.optionalKey(S.String),
});
export type ActionRequest = typeof ActionRequest.Type;

export const ActionResult = S.Struct({
  accepted: S.Boolean,
  message: S.optionalKey(S.String), // shown as a toast when present
});
export type ActionResult = typeof ActionResult.Type;

/** GET /conversation?before=<itemId>&limit=<n>. Newest first; next is the cursor for older items. */
export const ConversationPage = S.Struct({
  items: S.Array(ConversationItem),
  next: S.NullOr(Id),
});
export type ConversationPage = typeof ConversationPage.Type;

/** GET /reports/morning/latest */
export const LatestMorningReport = S.NullOr(MorningReport);
export type LatestMorningReport = typeof LatestMorningReport.Type;

/** POST /reports/morning/{reportId}/heard */
export const ReportHeard = S.Struct({ reportId: Id, heardAt: IsoTime });
export type ReportHeard = typeof ReportHeard.Type;

/** GET /capabilities. Informational only; clients never route on it. */
export const FrontCapabilities = S.Struct({
  version: S.Literal(1),
  cards: S.Array(S.String),
  actions: S.Array(S.String),
});
export type FrontCapabilities = typeof FrontCapabilities.Type;

/**
 * Body of every non-2xx response. `error` codes: "unavailable" (Otis or a
 * dependency is down; the client shows "Can't reach Otis right now"),
 * "not-found", "bad-request", "unauthorized". Open set; unknown codes are
 * treated as unavailable.
 */
export const FrontError = S.Struct({ error: NonBlank, message: S.String });
export type FrontError = typeof FrontError.Type;
