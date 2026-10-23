export function plainError(message: string, context: "provider" | "turn" = "turn"): string {
  if (/subscription.required|account cannot use/i.test(message)) {
    return "This account can't use that assistant. Choose a different assistant.";
  }
  if (/unauth|sign.?in|login|token.*expir|auth.*expir|\b401\b/i.test(message)) {
    return "Your sign-in has expired. Sign in again in Settings.";
  }
  if (/usage.?limit|rate.?limit|quota|capacity|\b429\b/i.test(message)) {
    return "The assistant is busy or has reached its limit. Try again later.";
  }
  if (/daemon|app-server|connect|socket|ECONN|EPIPE|timed out|timeout|network/i.test(message)) {
    return context === "provider"
      ? "The assistant isn't connected yet. T3 will check again."
      : "The connection was interrupted. Check the last reply, then try again.";
  }
  if (/workspace.*(missing|no longer)|folder.*(missing|no longer)|ENOENT/i.test(message)) {
    return "The work folder is missing. Choose an available folder in the project settings.";
  }
  return context === "provider"
    ? "The assistant isn't available. Open its settings to check the connection."
    : "Your message couldn't finish. Check the last reply, then try again.";
}
