import { expect, it } from "@effect/vitest";
import { dateOnlyThreadTitle } from "./threadTitle.ts";

it("removes launcher clock prefixes without changing dates or times in the subject", () => {
  expect(dateOnlyThreadTitle("11/8 4:32 a.m. Collect statements")).toBe("11/8 Collect statements");
  expect(dateOnlyThreadTitle("11/8 12:32 PM Collect statements")).toBe("11/8 Collect statements");
  expect(dateOnlyThreadTitle("11/8 Collect statements at 4:30 p.m.")).toBe(
    "11/8 Collect statements at 4:30 p.m.",
  );
  expect(dateOnlyThreadTitle("Call at 4:30 p.m.")).toBe("Call at 4:30 p.m.");
});

it("adds the creation date to an undated generated title using the Workroom timezone", () => {
  expect(dateOnlyThreadTitle("Workspace and rules", "2026-11-09T02:00:00Z")).toBe(
    "11/8 Workspace and rules",
  );
  expect(dateOnlyThreadTitle("11/7 Existing date", "2026-11-09T02:00:00Z")).toBe(
    "11/7 Existing date",
  );
});
