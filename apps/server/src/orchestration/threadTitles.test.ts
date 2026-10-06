import { describe, expect, it } from "@effect/vitest";
import { canReplaceThreadTitle, withCreationDate } from "./threadTitles.ts";

describe("automatic chat title dates", () => {
  it("uses the creation day in Christine's timezone, not UTC or the rename day", () => {
    expect(withCreationDate("Audit ITA AR inbox", "2026-10-05T02:30:00Z")).toBe(
      "10/4 Audit ITA AR inbox",
    );
    expect(withCreationDate("Review", "2026-01-02T04:30:00Z")).toBe("1/1 Review");
  });

  it("handles both sides of daylight saving time", () => {
    expect(withCreationDate("Review", "2026-03-09T04:30:00Z")).toBe("3/9 Review");
    expect(withCreationDate("Review", "2026-11-02T04:30:00Z")).toBe("11/1 Review");
  });

  it("is idempotent and replaces generated date prefixes without stacking them", () => {
    const createdAt = "2026-10-05T02:30:00Z";
    const title = withCreationDate("Audit", createdAt);
    expect(withCreationDate(title, createdAt)).toBe(title);
    expect(withCreationDate("10/5 10/4 Audit", createdAt)).toBe(title);
    expect(withCreationDate("10/04 Audit", createdAt)).toBe(title);
  });

  it("keeps title content and favorite markers", () => {
    expect(withCreationDate("** Home", "2026-10-04T16:00:00Z")).toBe("10/4 ** Home");
  });

  it("does not weaken protection of a manually named chat", () => {
    expect(canReplaceThreadTitle("My own title", "Original seed")).toBe(false);
    expect(canReplaceThreadTitle("New thread")).toBe(true);
  });

  it("refuses missing creation dates instead of using today's date", () => {
    expect(() => withCreationDate("Audit", "")).toThrow();
  });
});
