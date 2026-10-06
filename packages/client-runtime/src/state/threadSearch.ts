// @effect-diagnostics globalDate:off - Calendar filters use the client's local timezone, including daylight-saving boundaries.
import {
  type ChatHistorySearchInput,
  type ChatHistoryMatch,
  type ChatHistorySearchResult,
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

/** Local calendar days become an inclusive start and exclusive end on the wire. */
export function chatHistoryDateInput(
  query: string,
  from: string,
  through: string,
): ChatHistorySearchInput {
  for (const date of [from, through]) {
    if (!date) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Enter dates as YYYY-MM-DD.");
    const parsed = new Date(`${date}T00:00:00`);
    const [year, month, day] = date.split("-").map(Number);
    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() + 1 !== month ||
      parsed.getDate() !== day
    )
      throw new Error("Enter valid dates.");
  }
  const start = from ? new Date(`${from}T00:00:00`) : null;
  const end = through ? new Date(`${through}T00:00:00`) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime())))
    throw new Error("Enter valid dates.");
  if (start && end && start > end)
    throw new Error("The end date must be on or after the start date.");
  if (end) end.setDate(end.getDate() + 1);
  return {
    query: query.trim(),
    ...(start ? { from: start.toISOString() } : {}),
    ...(end ? { before: end.toISOString() } : {}),
  };
}

export function mergeChatHistoryMatches(
  previous: ReadonlyArray<ChatHistoryMatch>,
  next: ReadonlyArray<ChatHistoryMatch>,
) {
  const matches = new Map<string, ChatHistoryMatch>();
  for (const match of [...previous, ...next]) {
    const key = match.codexThreadId
      ? `codex:${match.codexThreadId}`
      : `${match.source}:${match.threadId}`;
    const existing = matches.get(key);
    if (!existing || match.source === "codex-app") matches.set(key, match);
  }
  return [...matches.values()];
}

export interface ChatHistoryScan {
  readonly codexCursor: string | undefined;
  readonly matches: ReadonlyArray<ChatHistoryMatch>;
  readonly pages: number;
  readonly seenCursors: ReadonlyArray<string>;
  readonly done: boolean;
  readonly readGaps: boolean;
}

export const INITIAL_CHAT_HISTORY_SCAN: ChatHistoryScan = {
  codexCursor: undefined,
  matches: [],
  pages: 0,
  seenCursors: [],
  done: false,
  readGaps: false,
};

/** Each computer scans bounded daemon pages, retaining results and coverage gaps. */
export function advanceChatHistoryScan(
  scan: ChatHistoryScan,
  page: ChatHistorySearchResult,
): ChatHistoryScan {
  const current = scan.codexCursor ?? "";
  if (scan.done || scan.seenCursors.includes(current)) return scan;
  const seenCursors = [...scan.seenCursors, current];
  const repeatsCursor = page.nextCodexCursor !== null && seenCursors.includes(page.nextCodexCursor);
  return {
    codexCursor: page.nextCodexCursor ?? scan.codexCursor,
    matches: mergeChatHistoryMatches(scan.matches, page.matches),
    pages: scan.pages + 1,
    seenCursors,
    done: page.nextCodexCursor === null || repeatsCursor,
    readGaps:
      scan.readGaps ||
      repeatsCursor ||
      page.coverage.some(
        (coverage) => coverage.readGaps === true || coverage.status === "unavailable",
      ),
  };
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Array(EnvironmentId), OrchestrationSearchThreadsInput.fields.query]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): string {
  return JSON.stringify([
    [...environmentIds].sort((left, right) => left.localeCompare(right)),
    query,
  ]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/**
 * Combines one search query atom per environment. Invalid search keys, failed
 * requests, and disconnected environments contribute no content matches,
 * preserving local title search as the compatibility fallback.
 */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false };
      }

      const [environmentIds, query] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query));
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          matches.push(
            ...value.matches.map((match) => ({
              ...match,
              environmentId,
            })),
          );
        }
      }

      return { matches, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}
