import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime } from "./baseSchemas.ts";

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export function dateOnlyThreadTitle(title: string): string {
  return title.replace(/^(\d{1,2}\/\d{1,2})\s+\d{1,2}:\d{2}\s*[ap]\.?m\.?\s+/iu, "$1 ");
}
