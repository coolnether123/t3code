import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ComputerOpenUrlInput } from "./computerControl.ts";

const decode = Schema.decodeUnknownEffect(ComputerOpenUrlInput);

it.effect("accepts long authentication URLs without restricting their domain", () =>
  Effect.gen(function* () {
    const url = `https://cfahome.okta.com/app/sso/saml?SAMLRequest=${"x".repeat(6_000)}`;
    expect(yield* decode({ url })).toEqual({ url });
  }),
);

it.effect("rejects non-web protocols", () =>
  Effect.gen(function* () {
    const error = yield* decode({ url: "file:///C:/Users/secret.txt" }).pipe(Effect.flip);
    expect(String(error)).toContain("http or https");
  }),
);
