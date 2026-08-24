import { assert, describe, it } from "@effect/vitest";

import {
  appendBoundedCodexDiagnostic,
  CODEX_APP_SERVER_STDERR_MAX_CHARS,
  sanitizeCodexDiagnosticText,
} from "./diagnostics.ts";

describe("Codex app-server diagnostics", () => {
  it("redacts credentials and strips terminal control sequences", () => {
    const value = sanitizeCodexDiagnosticText(
      `${String.fromCharCode(27)}[31mAuthorization: Bearer bearer-secret\napi_key=api-secret`,
    );

    assert.notInclude(value, "bearer-secret");
    assert.notInclude(value, "api-secret");
    assert.include(value, "Authorization: Bearer [REDACTED]");
    assert.notInclude(value, String.fromCharCode(27));
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
