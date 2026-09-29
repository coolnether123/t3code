import {
  CodexDesktopThreadHistoryResponse,
  CodexScheduledRoutineListResponse,
  CodexScheduledRunListResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";
import { primaryEnvironmentHttpLayer } from "./environments/primary/httpLayer";

type Read = (url: string) => Promise<unknown>;

const readFromPrimary: Read = (url) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(HttpClientRequest.get(url));
      const body = yield* response.json;
      if (response.status < 200 || response.status >= 300) {
        throw new Error("Scheduled runs are unavailable on this environment.");
      }
      return body;
    }).pipe(Effect.provide(primaryEnvironmentHttpLayer)),
  );

export function createScheduledApi(
  read: Read = readFromPrimary,
  resolveUrl: (
    pathname: string,
    searchParams?: Record<string, string>,
  ) => string = resolvePrimaryEnvironmentHttpUrl,
) {
  const get = async <A>(
    pathname: string,
    schema: Schema.ConstraintDecoder<A>,
    searchParams?: Record<string, string>,
  ): Promise<A> => {
    const payload = await read(resolveUrl(pathname, searchParams));
    return Schema.decodeUnknownSync(schema)(payload);
  };
  return {
    listRoutines: (cursor?: string) =>
      get(
        "/api/codex/scheduled",
        CodexScheduledRoutineListResponse,
        cursor ? { cursor } : undefined,
      ),
    listRuns: (name: string, cursor?: string) =>
      get("/api/codex/scheduled/runs", CodexScheduledRunListResponse, {
        name,
        ...(cursor ? { cursor } : {}),
      }),
    getRun: (id: string, beforeCursor?: string) =>
      get(
        `/api/codex/scheduled/runs/${encodeURIComponent(id)}`,
        CodexDesktopThreadHistoryResponse,
        beforeCursor ? { beforeCursor } : undefined,
      ),
  };
}

export const scheduledApi = createScheduledApi();
