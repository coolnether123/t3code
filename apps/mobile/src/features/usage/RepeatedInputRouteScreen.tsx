import { useNavigation } from "@react-navigation/native";
import { mergeRepeatedInputSummaries } from "@t3tools/shared/usageRepeatedInput";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useUsage } from "../../state/usage";
import { RepeatedInputSection } from "./RepeatedInputSection";

const WINDOW_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;

export function RepeatedInputRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const { days, window } = windowSelection;
  const { environments, refresh } = useUsage({
    ...window,
    includeRepeatedInput: true,
  });
  const repeatedInput = useMemo(() => mergeRepeatedInputSummaries(environments), [environments]);
  const pending = environments.some((entry) => entry.isPending);
  const refreshing = environments.some((entry) => entry.isPending && entry.summary !== null);
  const incomplete = environments.filter(
    (entry) =>
      entry.error !== null || entry.isPending || entry.summary?.repeatedInput === undefined,
  );
  const failed = environments.filter((entry) => entry.error !== null);

  const selectWindow = (nextDays: number) => {
    setWindowSelection({ days: nextDays, window: makeWindow(nextDays) });
  };

  const refreshWindow = () => {
    if (refreshing) return;
    const nextWindow = makeWindow(days);
    if (nextWindow.sinceDay === window.sinceDay && nextWindow.untilDay === window.untilDay) {
      refresh();
    } else {
      setWindowSelection({ days, window: nextWindow });
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title: "Skills & repeated input" }} />
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Skills & repeated input" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshWindow} />}
      >
        <Text className="text-sm leading-5 text-foreground-muted">
          See which reusable inputs were available and which ones appeared in agent transcripts.
          References, likely reads, and confirmed payloads stay separate.
        </Text>
        <View className="flex-row overflow-hidden rounded-full border-continuous bg-card">
          {WINDOW_OPTIONS.map((option) => {
            const active = option.days === days;
            return (
              <Pressable
                key={option.days}
                accessibilityLabel={`Repeated input period, ${option.label}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => selectWindow(option.days)}
                className={
                  active
                    ? "flex-1 items-center rounded-full bg-subtle-strong py-2"
                    : "flex-1 items-center py-2"
                }
              >
                <Text
                  className={
                    active
                      ? "text-sm font-t3-medium text-foreground"
                      : "text-sm text-foreground-muted"
                  }
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {repeatedInput !== undefined && incomplete.length > 0 ? (
          <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
            <Text className="text-sm text-foreground-muted">
              Showing available attribution. Some environments have not returned a complete result.
            </Text>
            {incomplete.map((entry) => (
              <Text key={entry.environmentId} className="text-xs text-foreground-muted">
                {entry.label}:{" "}
                {entry.error ?? (entry.isPending ? "Updating" : "Attribution unavailable")}
              </Text>
            ))}
          </View>
        ) : null}
        {pending && repeatedInput === undefined ? (
          <View className="gap-2 py-16">
            <Text
              accessibilityLiveRegion="polite"
              className="text-center text-base text-foreground-muted"
            >
              Scanning skills and repeated inputs…
            </Text>
            {failed.map((entry) => (
              <Text key={entry.environmentId} className="text-center text-sm text-foreground-muted">
                {entry.label}: {entry.error}
              </Text>
            ))}
          </View>
        ) : environments.length === 0 ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Connect an environment to see repeated input.
          </Text>
        ) : repeatedInput === undefined ? (
          <View className="gap-2 py-16">
            <Text className="text-center text-base text-foreground-muted">
              {failed.length > 0
                ? "Repeated-input attribution is unavailable."
                : "No repeated-input data is available for this period."}
            </Text>
            {failed.map((entry) => (
              <Text key={entry.environmentId} className="text-center text-sm text-foreground-muted">
                {entry.label}: {entry.error}
              </Text>
            ))}
          </View>
        ) : (
          <RepeatedInputSection data={repeatedInput} />
        )}
      </ScrollView>
    </View>
  );
}
