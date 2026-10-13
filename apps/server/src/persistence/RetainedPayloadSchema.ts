import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { restoreStoredPayload } from "./ToolPayloadCodec.ts";

export const RetainedPayloadFromJsonString = Schema.fromJsonString(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transformOrFail({
      decode: (payload) =>
        Effect.try({
          try: () => restoreStoredPayload(payload),
          catch: () => new SchemaIssue.InvalidValue({ message: "Invalid retained tool payload" }),
        }),
      encode: Effect.succeed,
    }),
  ),
);
