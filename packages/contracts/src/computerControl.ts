import { Schema } from "effect";

const HttpUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(8_192))
  .check(
    Schema.makeFilter((value) => {
      try {
        const parsed = new URL(value);
        return (
          parsed.protocol === "http:" ||
          parsed.protocol === "https:" ||
          "URL must use the http or https protocol."
        );
      } catch {
        return "URL must be an absolute http or https URL.";
      }
    }),
  )
  .annotate({
    description:
      "Exact absolute HTTP or HTTPS URL to open. Domains are not restricted; long authentication and relay URLs are supported.",
  });

export const ComputerOpenUrlInput = Schema.Struct({ url: HttpUrl });
export type ComputerOpenUrlInput = typeof ComputerOpenUrlInput.Type;

export const ComputerOpenUrlResult = Schema.Struct({
  opened: Schema.Literal(true),
});
export type ComputerOpenUrlResult = typeof ComputerOpenUrlResult.Type;

export class ComputerControlUnavailableError extends Schema.TaggedErrorClass<ComputerControlUnavailableError>()(
  "ComputerControlUnavailableError",
  {
    message: Schema.String,
  },
) {}

export class ComputerOpenUrlFailedError extends Schema.TaggedErrorClass<ComputerOpenUrlFailedError>()(
  "ComputerOpenUrlFailedError",
  {
    message: Schema.String,
  },
) {}
