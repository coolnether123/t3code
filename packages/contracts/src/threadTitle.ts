import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

import { CommandId, IsoDateTime } from "./baseSchemas.ts";

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export function dateOnlyThreadTitle(title: string, createdAt?: string): string {
  const normalized = title.replace(/^(\d{1,2}\/\d{1,2})\s+\d{1,2}:\d{2}\s*[ap]\.?m\.?\s+/iu, "$1 ");
  if (!createdAt || /^\d{1,2}\/\d{1,2}\s/u.test(normalized) || normalized === "New thread")
    return normalized;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
  }).format(DateTime.toEpochMillis(DateTime.makeUnsafe(createdAt)));
  return `${date} ${normalized}`;
}
