import { assert, describe, it } from "@effect/vitest";

import {
  appendBoundedCodexDiagnostic,
  CODEX_APP_SERVER_STDERR_MAX_CHARS,
  sanitizeCodexDiagnosticText,
} from "./diagnostics.ts";

describe("Codex app-server diagnostics", () => {
  it("redacts credentials and strips terminal control sequences", () => {
    const value = sanitizeCodexDiagnosticText(
      `${String.fromCharCode(27)}[31mAuthorization: Bearer bearer-secret\n` +
        `OPENAI_API_KEY=api-secret\n` +
        `{"apiKey":"json-api-secret","access_token":"json-access-secret"}\n` +
        `Token: direct-token\nCookie: session=cookie-secret`,
    );

    assert.notInclude(value, "bearer-secret");
    assert.notInclude(value, "api-secret");
    assert.notInclude(value, "json-api-secret");
    assert.notInclude(value, "json-access-secret");
    assert.notInclude(value, "direct-token");
    assert.notInclude(value, "cookie-secret");
    assert.include(value, "Authorization: Bearer [REDACTED]");
    assert.include(value, "OPENAI_API_KEY=[REDACTED]");
    assert.include(value, `{"apiKey":"[REDACTED]","access_token":"[REDACTED]"}`);
    assert.include(value, "Token: [REDACTED]");
    assert.include(value, "Cookie: [REDACTED]");
    assert.notInclude(value, String.fromCharCode(27));
  });

  it("does not redact harmless prose that only mentions credential vocabulary", () => {
    const value =
      "Token usage: 3200. Cookie policy: strict. Keep the secret sauce recipe and rotate the API key tomorrow.";

    assert.equal(sanitizeCodexDiagnosticText(value), value);
  });

  it("caps captured diagnostics", () => {
    const result = appendBoundedCodexDiagnostic(
      "",
      "x".repeat(CODEX_APP_SERVER_STDERR_MAX_CHARS + 10),
    );
    assert.equal(result.value.length, CODEX_APP_SERVER_STDERR_MAX_CHARS);
    assert.equal(result.truncated, true);
  });
});
