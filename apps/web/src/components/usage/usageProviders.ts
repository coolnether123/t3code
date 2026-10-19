import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, OpenAI, AntigravityIcon, CursorIcon } from "../Icons";
import { createElement } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
const providerMark =
  (driver: string, label: string): Icon =>
  (props) =>
    createElement(ProviderInstanceIcon, {
      driverKind: ProviderDriverKind.make(driver),
      displayName: label,
      showBadge: false,
      ...(props.className === undefined
        ? {}
        : { className: props.className, iconClassName: props.className }),
    });
const Gemini = providerMark("gemini", "Gemini");
const GrokIcon = providerMark("grok", "Grok");
const OpenCodeIcon = providerMark("opencode", "OpenCode");
const PiIcon = providerMark("pi", "Pi");

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
  readonly driverKind: ProviderDriverKind;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    color: "var(--contrast-foreground)",
    mark: OpenAI,
  },
  claude: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  gemini: {
    driverKind: ProviderDriverKind.make("gemini"),
    label: "Gemini",
    color: "#4e8cff",
    mark: Gemini,
  },
  opencode: {
    driverKind: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    color: "#7c9cff",
    mark: OpenCodeIcon,
  },
  chatgpt: {
    driverKind: ProviderDriverKind.make("codex"),
    label: "ChatGPT archive",
    color: "#10a37f",
    mark: OpenAI,
  },
  aistudio: {
    driverKind: ProviderDriverKind.make("gemini"),
    label: "AI Studio archive",
    color: "#f9ab00",
    mark: Gemini,
  },
  grok: {
    driverKind: ProviderDriverKind.make("grok"),
    label: "Grok",
    color: "#e5e5e5",
    mark: GrokIcon,
  },
  cursor: {
    driverKind: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    color: "#8b8b8b",
    mark: CursorIcon,
  },
  antigravity: {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    color: "#8c7bd1",
    mark: AntigravityIcon,
  },
  pi: { driverKind: ProviderDriverKind.make("pi"), label: "Pi", color: "#4d9f8a", mark: PiIcon },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
