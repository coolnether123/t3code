import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return (
      getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? {
        metric: "cost",
        windowDays: 30,
      }
    );
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return { metric: "cost", windowDays: 30 };
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}

const LIMITS_VIEW_KEY = "t3code:usage-limits-view:v1";
const LimitsViewSchema = Schema.Struct({
  provider: Schema.Literals(["codex", "claude", "both"]),
  windowKey: Schema.optional(Schema.String),
  tab: Schema.Literals(["cycles", "models", "planner", "public"]),
});
export type LimitsView = typeof LimitsViewSchema.Type;
const DEFAULT_LIMITS_VIEW: LimitsView = { provider: "both", tab: "cycles" };

/** The limits page's provider filter, charted limit, and open tab, per browser. */
export function readLimitsView(): LimitsView {
  try {
    return getLocalStorageItem(LIMITS_VIEW_KEY, LimitsViewSchema) ?? DEFAULT_LIMITS_VIEW;
  } catch {
    return DEFAULT_LIMITS_VIEW;
  }
}

export function saveLimitsView(view: LimitsView): void {
  try {
    setLocalStorageItem(LIMITS_VIEW_KEY, view, LimitsViewSchema);
  } catch {
    // A preference that cannot be saved only resets on the next visit.
  }
}
