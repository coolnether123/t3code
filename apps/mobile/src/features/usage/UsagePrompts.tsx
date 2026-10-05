import type { UsageReportInput, UsageReportPrompts } from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";

export function PromptUsageContent({ report }: { readonly report: UsageReportPrompts }) {
  if (report.coverage.status === "missing") {
    return <Text className="text-sm text-foreground-muted">Prompt history is unavailable.</Text>;
  }
  const dailyDescending = [...report.daily];
  // Hermes does not support toReversed. Reverse only the local copy.
  dailyDescending.reverse();
  return (
    <View className="gap-3">
      {report.coverage.status === "partial" ? (
        <Text className="text-sm text-foreground-muted">
          Partial history. These counts cover only the messages examined, not the entire period.
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-x-6 gap-y-3">
        {[
          ["Prompts", formatCount(report.totals.prompts)],
          ["Words", formatCount(report.totals.words)],
          ["Words per prompt", report.totals.averageWordsPerPrompt?.toFixed(1) ?? "Unavailable"],
          ["Chats", formatCount(report.totals.threads)],
          ["Active days", formatCount(report.totals.activeDays)],
        ].map(([label, value]) => (
          <View key={label} className="gap-1">
            <Text className="text-xs text-foreground-muted">{label}</Text>
            <Text className="text-sm font-t3-medium tabular-nums">{value}</Text>
          </View>
        ))}
      </View>
      {report.totals.prompts === 0 ? (
        <Text className="text-sm text-foreground-muted">
          No stored user prompts in this period.
        </Text>
      ) : (
        <>
          <Text accessibilityRole="header" className="text-sm font-t3-medium">
            Frequent words
          </Text>
          <Text className="text-xs text-foreground-muted">
            Common English words and word runs containing digits omitted.
          </Text>
          {report.words.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No words remain after filtering.</Text>
          ) : (
            report.words.map(({ word, count }) => (
              <View key={word} className="flex-row justify-between gap-3">
                <Text className="min-w-0 flex-1 text-sm">{word}</Text>
                <Text className="text-sm tabular-nums text-foreground-muted">
                  {formatCount(count)}
                </Text>
              </View>
            ))
          )}
          {report.wordsTruncated ? (
            <Text className="text-xs text-foreground-muted">
              Showing {report.words.length} of {formatCount(report.countedDistinctWords)} counted
              words.
            </Text>
          ) : null}
          <Text accessibilityRole="header" className="text-sm font-t3-medium">
            Daily prompt usage
          </Text>
          <View className="flex-row gap-2">
            <Text className="flex-1 text-xs text-foreground-muted">Day</Text>
            <Text className="w-16 text-right text-xs text-foreground-muted">Prompts</Text>
            <Text className="w-16 text-right text-xs text-foreground-muted">Words</Text>
          </View>
          {dailyDescending.map((day) => (
            <View key={day.day} className="flex-row gap-2">
              <Text className="flex-1 text-sm">{day.day}</Text>
              <Text className="w-16 text-right text-sm tabular-nums">
                {formatCount(day.prompts)}
              </Text>
              <Text className="w-16 text-right text-sm tabular-nums">{formatCount(day.words)}</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

function EnvironmentPrompts({
  environment,
  input,
  refreshRevision,
}: {
  readonly environment: EnvironmentUsageStatus;
  readonly input: UsageReportInput;
  readonly refreshRevision: number;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.usageReport({
      environmentId: environment.environmentId,
      input,
    }),
  );
  const { refresh } = query;
  const previousRefresh = useRef(refreshRevision);
  useEffect(() => {
    if (previousRefresh.current === refreshRevision) return;
    previousRefresh.current = refreshRevision;
    refresh();
  }, [refreshRevision, refresh]);
  return (
    <View className="gap-3 border-t border-subtle pt-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text accessibilityRole="header" className="min-w-0 flex-1 text-sm font-t3-medium">
          {environment.label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Refresh prompt usage for ${environment.label}`}
          accessibilityState={{ disabled: query.isPending }}
          disabled={query.isPending}
          className="min-h-11 justify-center px-3"
          onPress={refresh}
        >
          <Text className="text-sm text-foreground-muted">Refresh</Text>
        </Pressable>
      </View>
      {query.error ? (
        <Text className="text-sm text-foreground-muted">
          {query.data?.mode === "prompts"
            ? "Prompt history could not be refreshed. Showing the last result."
            : "Connect this environment to read prompt history, or try Refresh."}
        </Text>
      ) : null}
      {query.data?.mode === "prompts" ? (
        <PromptUsageContent report={query.data} />
      ) : !query.error ? (
        <Text className="text-sm text-foreground-muted">
          {query.isPending
            ? "Reading prompt history..."
            : "Prompt history is unavailable on this server."}
        </Text>
      ) : null}
    </View>
  );
}

export function UsagePrompts({
  environments,
  window,
  refreshRevision,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly window: Omit<UsageReportInput, "mode">;
  readonly refreshRevision: number;
}) {
  const input: UsageReportInput = {
    mode: "prompts",
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
    timeZone: window.timeZone,
    limit: 20,
    ...(window.sinceTime === undefined
      ? {}
      : { sinceTime: window.sinceTime, untilTime: window.untilTime }),
  };
  return (
    <SettingsSection title="Prompts & words">
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          Stored T3 user messages only, including imported and archived chats. Attachment contents
          and agent replies are excluded. Words are not tokens. Copies in separate chats count
          separately; environments are not added together.
        </Text>
        {environments.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            Connect an environment to see prompt usage.
          </Text>
        ) : (
          environments.map((environment) => (
            <EnvironmentPrompts
              key={environment.environmentId}
              environment={environment}
              input={input}
              refreshRevision={refreshRevision}
            />
          ))
        )}
      </View>
    </SettingsSection>
  );
}
