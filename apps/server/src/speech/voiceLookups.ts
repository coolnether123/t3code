import * as Schema from "effect/Schema";
import type { VoiceLookup } from "./operatorProtocol.ts";

const task = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  outcome: Schema.optional(Schema.String),
  needsAgent: Schema.optional(Schema.String),
  needsUser: Schema.optional(Schema.String),
});
const decodeSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    tasks: Schema.Array(task),
    partial: Schema.optional(Schema.Boolean),
  }),
);
const decodeTask = Schema.decodeUnknownSync(task);

/** Only the local agenda read API is reachable, never a model-supplied URL. */
export async function lookupVoiceAgenda(
  input: VoiceLookup,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (input.tool !== "agenda_lookup" || !input.query?.trim())
    return { error: "Supply a specific agenda task ID or search words." };
  const query = input.query.trim();
  if (query.length > 200 || /\p{Cc}/u.test(query))
    return { error: "The agenda search is too long or contains control characters." };
  const exact = /^agenda-task:[a-f0-9]{32}$/.test(query);
  const url = new URL(
    exact ? `/api/v1/agenda/tasks/${encodeURIComponent(query)}` : "/api/v1/agenda/search",
    "http://127.0.0.1:5197",
  );
  if (!exact) {
    url.searchParams.set("query", query);
    url.searchParams.set("limit", "5");
  }
  const response = await fetcher(url, {
    method: "GET",
    headers: { "X-Otis-Actor": "user:local" },
    signal,
    redirect: "error",
  });
  if (!response.ok)
    return { error: `Agenda read returned HTTP ${response.status}. Coverage is unknown.` };
  const data: unknown = await response.json();
  const project = (entry: typeof task.Type) => ({
    id: entry.id,
    title: entry.title,
    status: entry.status,
    outcome: entry.outcome,
    needsAgent: entry.needsAgent,
    needsUser: entry.needsUser,
  });
  if (exact) return { tasks: [project(decodeTask(data))], partial: false };
  const result = decodeSearch(data);
  return { tasks: result.tasks.slice(0, 5).map(project), partial: result.partial ?? true };
}
