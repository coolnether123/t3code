import type { CodexDesktopMessage, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { scheduledRuns } from "../../state/scheduled";
import { useWorkspaceState } from "../../state/workspace";

const time = (value: string) => new Date(value).toLocaleString();

function Row({ label, detail, onPress }: { label: string; detail?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="border-b border-border px-5 py-3 active:bg-subtle"
    >
      <Text className="text-base text-foreground">{label}</Text>
      {detail ? <Text className="mt-1 text-xs text-foreground-muted">{detail}</Text> : null}
    </Pressable>
  );
}

function Message({ message }: { message: CodexDesktopMessage }) {
  return (
    <View className="border-b border-border px-5 py-4">
      <Text className="mb-1 text-xs font-t3-bold text-foreground-muted">
        {message.role === "tool"
          ? (message.tool?.name ?? "Tool")
          : message.role === "user"
            ? "You"
            : "Codex"}
      </Text>
      <Text className="text-sm text-foreground">{message.text}</Text>
    </View>
  );
}

/** A separate native list. These runs never enter the normal thread projection. */
export function ScheduledRouteScreen() {
  const { environments } = useWorkspaceState();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    chosenEnvironmentId ??
    environments.find((environment) => environment.connectionState === "connected")
      ?.environmentId ??
    null;
  const [routineCursor, setRoutineCursor] = useState<string | undefined>();
  const [selectedRoutine, setSelectedRoutine] = useState<string | null>(null);
  const [runsCursor, setRunsCursor] = useState<string | undefined>();
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | undefined>();

  const routinesQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : scheduledRuns.routines({ environmentId, input: { cursor: routineCursor } }),
  );
  const runsQuery = useEnvironmentQuery(
    environmentId === null || selectedRoutine === null
      ? null
      : scheduledRuns.runs({ environmentId, input: { name: selectedRoutine, cursor: runsCursor } }),
  );
  const transcriptQuery = useEnvironmentQuery(
    environmentId === null || selectedRun === null
      ? null
      : scheduledRuns.transcript({
          environmentId,
          input: { id: selectedRun, beforeCursor: messageCursor },
        }),
  );

  const selectEnvironment = (id: EnvironmentId) => {
    setChosenEnvironmentId(id);
    setRoutineCursor(undefined);
    setSelectedRoutine(null);
    setSelectedRun(null);
  };
  const selectRoutine = (name: string) => {
    setSelectedRoutine(selectedRoutine === name ? null : name);
    setRunsCursor(undefined);
    setSelectedRun(null);
  };
  const selectRun = (id: string) => {
    setSelectedRun(id);
    setMessageCursor(undefined);
  };

  return (
    <View className="flex-1 bg-background">
      <NativeStackScreenOptions options={{ title: selectedRun ? "Scheduled run" : "Scheduled" }} />
      <ScrollView className="flex-1" contentContainerClassName="pb-10">
        {selectedRun ? (
          <>
            <Row label="Back to runs" onPress={() => setSelectedRun(null)} />
            <Text className="px-5 py-3 text-xs text-foreground-muted">
              Read-only. Continuing a specific automation run in a T3 chat is not available yet.
            </Text>
            {transcriptQuery.error ? (
              <Text className="px-5 py-2 text-sm text-destructive">{transcriptQuery.error}</Text>
            ) : null}
            {messageCursor ? (
              <Row label="Back to latest messages" onPress={() => setMessageCursor(undefined)} />
            ) : null}
            {transcriptQuery.data?.nextCursor ? (
              <Row
                label="Older messages"
                onPress={() => setMessageCursor(transcriptQuery.data!.nextCursor!)}
              />
            ) : null}
            {transcriptQuery.data?.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {transcriptQuery.isPending ? (
              <Text className="px-5 py-3 text-sm text-foreground-muted">Loading…</Text>
            ) : null}
          </>
        ) : (
          <>
            {environments.filter((environment) => environment.connectionState === "connected")
              .length > 1 ? (
              <View className="flex-row flex-wrap gap-2 px-5 py-3">
                {environments
                  .filter((environment) => environment.connectionState === "connected")
                  .map((environment) => (
                    <Pressable
                      key={environment.environmentId}
                      accessibilityRole="button"
                      onPress={() => selectEnvironment(environment.environmentId)}
                      className="rounded-full border border-border px-3 py-2"
                    >
                      <Text className="text-xs text-foreground">
                        {environment.environmentLabel}
                        {environmentId === environment.environmentId ? " ✓" : ""}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            ) : null}
            {environmentId === null ? (
              <Text className="px-5 py-4 text-sm text-foreground-muted">
                Connect to a T3 environment to see its scheduled runs.
              </Text>
            ) : null}
            {routinesQuery.error ? (
              <Row label="Could not load routines. Retry" onPress={routinesQuery.refresh} />
            ) : null}
            {routinesQuery.data && routinesQuery.data.routines.length === 0 ? (
              <Text className="px-5 py-4 text-sm text-foreground-muted">
                No scheduled runs on this Codex host.
              </Text>
            ) : null}
            {routinesQuery.data?.routines.map((routine) => (
              <View key={routine.name}>
                <Row
                  label={`${selectedRoutine === routine.name ? "▾" : "▸"} ${routine.name}`}
                  detail={`${time(routine.latestRun.createdAt)} · ${routine.runCount} runs`}
                  onPress={() => selectRoutine(routine.name)}
                />
                {selectedRoutine === routine.name ? (
                  <View className="pl-4">
                    {runsQuery.error ? (
                      <Row label="Could not load runs. Retry" onPress={runsQuery.refresh} />
                    ) : null}
                    {runsCursor ? (
                      <Row label="Back to latest runs" onPress={() => setRunsCursor(undefined)} />
                    ) : null}
                    {runsQuery.data?.runs.map((run) => (
                      <Row
                        key={run.id}
                        label={time(run.createdAt)}
                        detail={`${run.archived ? "Archived · " : ""}${run.preview?.trim() || "Run"}`}
                        onPress={() => selectRun(run.id)}
                      />
                    ))}
                    {runsQuery.data?.nextCursor && !runsQuery.isPending ? (
                      <Row
                        label="More runs"
                        onPress={() => setRunsCursor(runsQuery.data!.nextCursor!)}
                      />
                    ) : null}
                    {runsQuery.isPending ? (
                      <Text className="px-5 py-3 text-xs text-foreground-muted">Loading…</Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ))}
            {routineCursor ? (
              <Row
                label="Back to latest routines"
                onPress={() => {
                  setRoutineCursor(undefined);
                  setSelectedRoutine(null);
                }}
              />
            ) : null}
            {routinesQuery.data?.nextCursor && !routinesQuery.isPending ? (
              <Row
                label="More routines"
                onPress={() => {
                  setRoutineCursor(routinesQuery.data!.nextCursor!);
                  setSelectedRoutine(null);
                }}
              />
            ) : null}
            {routinesQuery.isPending ? (
              <Text className="px-5 py-3 text-sm text-foreground-muted">Loading…</Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
