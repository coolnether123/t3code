/**
 * Recognizes hook feedback from a Stop hook that kept a turn going because the
 * user had already approved what the agent was about to ask. The hook's text is
 * the contract:
 *
 *   <Name> already approved this in this chat, so do not ask her again:
 *   “<quote>”. Carry on and finish the task, … (Otis permission check J-XXXXXX)
 *
 * Clients render a match as a "You already approved this" card with the quote
 * and a way to stop the agent. Anything else stays an ordinary work-log row.
 */
export interface PermissionContinuation {
  /** The user's own words (or standing rule) the approval rests on. */
  readonly quote: string;
  readonly source: "chat" | "standing-rule";
  /** CodexDeck decision id, for support and audit. */
  readonly checkId: string;
}

const PATTERN =
  /already approved this (in this chat|in [a-z]+ standing workroom rules), so do not ask [a-z]+ again: “([\s\S]+)”\.[\s\S]*\(Otis permission check (J-[A-Z0-9]{4,12})\)\s*$/;

export function parsePermissionContinuation(
  text: string | null | undefined,
): PermissionContinuation | null {
  if (!text) return null;
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const quote = match[2]!.trim();
  if (!quote) return null;
  return {
    quote,
    source: match[1] === "in this chat" ? "chat" : "standing-rule",
    checkId: match[3]!,
  };
}
