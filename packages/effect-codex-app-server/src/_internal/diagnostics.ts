const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*[A-Za-z]`, "g");

export const CODEX_APP_SERVER_STDERR_MAX_CHARS = 8_192;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/((?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/giu, "$1[REDACTED]"],
  [
    /(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1[REDACTED]",
  ],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
];

export function sanitizeCodexDiagnosticText(value: string): string {
  let sanitized = value
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/\0/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

export function appendBoundedCodexDiagnostic(
  current: string,
  chunk: string,
): { readonly value: string; readonly truncated: boolean } {
  const sanitized = sanitizeCodexDiagnosticText(current + chunk);
  if (sanitized.length <= CODEX_APP_SERVER_STDERR_MAX_CHARS) {
    return { value: sanitized, truncated: false };
  }
  return {
    value: sanitized.slice(0, CODEX_APP_SERVER_STDERR_MAX_CHARS),
    truncated: true,
  };
}
