import { describe, expect, it } from "vite-plus/test";
import { plainError } from "./plainError";

describe("plain errors", () => {
  it("does not mistake a missing daemon socket for a missing work folder", () => {
    expect(plainError("ENOENT /tmp/app-server-control.sock", "provider")).toBe(
      "The assistant isn't connected yet. T3 will check again.",
    );
  });
  it("does not mistake a port or duration for an authentication status", () => {
    expect(plainError("Connection to port 4013 failed after 401ms")).toBe(
      "The connection was interrupted. Check the last reply, then try again.",
    );
  });
  it("keeps daemon protocol detail out of the main provider message", () => {
    expect(
      plainError(
        "Codex desktop app daemon could not complete the app-server proxy connection",
        "provider",
      ),
    ).toBe("The assistant isn't connected yet. T3 will check again.");
  });
  it("gives a sign-in action before treating an authentication failure as a connection failure", () => {
    expect(plainError("Connection failed: authentication token expired")).toBe(
      "Your sign-in has expired. Sign in again in Settings.",
    );
  });
  it("does not invite blind resubmission after uncertain turn delivery", () => {
    expect(plainError("ECONNRESET during turn/start")).toBe(
      "The connection was interrupted. Check the last reply, then try again.",
    );
  });
  it("keeps unknown diagnostics out of the main message", () => {
    expect(plainError("INTERNAL: unexpected protocol state at /private/example")).toBe(
      "Your message couldn't finish. Check the last reply, then try again.",
    );
  });
});
