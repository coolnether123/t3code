import type { OtisFront } from "@t3tools/contracts";

export const chicagoTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  minute: "2-digit",
});

export function frontLink(href: string | null, taskDashboardUrl?: string) {
  if (!href) return null;
  if (href.startsWith("https://")) return { kind: "external", href } as const;
  const match = /^otis:\/\/(node|task)\/(.+)$/.exec(href);
  if (!match?.[2]) return null;
  if (match[1] === "node") return { kind: "node", id: match[2] } as const;
  if (!taskDashboardUrl?.startsWith("https://")) return null;
  return {
    kind: "external",
    href: `${taskDashboardUrl}#tracker?${new URLSearchParams({ task: match[2] })}`,
  } as const;
}

export function retryText(
  reply: OtisFront.ConversationItem,
  items: readonly OtisFront.ConversationItem[],
) {
  return reply.turnId
    ? items.find((item) => item.from === "jared" && item.turnId === reply.turnId)?.text
    : undefined;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function otisContext(otis: OtisFront.Otis1State) {
  return otis.contextTokens === null || otis.contextLimit === null
    ? null
    : [otis.contextTokens, otis.contextLimit].map((value) =>
        compact.format(value).replace("K", "k"),
      );
}

export function sameSender(
  previous: OtisFront.ConversationItem | undefined,
  item: OtisFront.ConversationItem,
) {
  return previous?.from === item.from && Date.parse(item.at) - Date.parse(previous.at) <= 120_000;
}

export function frontSpeechMessage(
  { event, turnId }: { event: typeof OtisFront.SpeakEvent.Type; turnId: string | null },
  generation: number,
) {
  return {
    id: `otis-front-${generation}-${event.seq}`,
    role: "assistant",
    text: event.text,
    streaming: false,
    turnId,
    nextPause: event.priority === "next-pause",
  };
}
