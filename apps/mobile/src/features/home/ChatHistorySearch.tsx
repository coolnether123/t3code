import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  CHAT_HISTORY_MESSAGE_PAGE_SIZE,
  type ChatHistoryMatch,
  type ChatHistorySearchInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  chatHistoryDateInput,
  mergeChatHistoryMatches,
} from "@t3tools/client-runtime/state/thread-search";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

type Computer = { environmentId: EnvironmentId; label: string };

function ComputerResults({
  computer,
  input,
  onOpen,
}: {
  computer: Computer;
  input: ChatHistorySearchInput;
  onOpen: (match: ChatHistoryMatch, computer: Computer) => void;
}) {
  const [cursor, setCursor] = useState<string>();
  const [t3Offset, setT3Offset] = useState(0);
  const [previous, setPrevious] = useState<ReadonlyArray<ChatHistoryMatch>>([]);
  const [hadMissingHistory, setHadMissingHistory] = useState(false);
  const search = useEnvironmentQuery(
    orchestrationEnvironment.chatHistorySearch({
      environmentId: computer.environmentId,
      input: { ...input, t3Offset, ...(cursor ? { codexCursor: cursor } : {}) },
    }),
  );
  const matches = mergeChatHistoryMatches(previous, search.data?.matches ?? []);
  return (
    <View className="gap-2 border-t border-border py-4">
      <Text className="font-t3-medium text-foreground">{computer.label}</Text>
      {search.isPending && <Text>Searching chats...</Text>}
      {search.error && (
        <Text accessibilityRole="alert">
          {computer.label} could not be searched. It may be disconnected or need an update.
        </Text>
      )}
      {(search.error ||
        search.data?.coverage.some((coverage) => coverage.status === "unavailable")) && (
        <Pressable
          accessibilityRole="button"
          onPress={search.refresh}
          className="min-h-11 justify-center"
        >
          <Text>Retry this computer</Text>
        </Pressable>
      )}
      {search.data?.coverage.map((coverage) => (
        <Text key={coverage.source} className="text-xs text-foreground-muted">
          {coverage.source === "t3" ? "T3" : "Codex app"}: {coverage.status}. {coverage.detail}
        </Text>
      ))}
      {hadMissingHistory && (
        <Text className="text-xs text-foreground-muted">
          An earlier page had missing or unreadable message history. Coverage remains incomplete.
        </Text>
      )}
      {!search.isPending && search.data && matches.length === 0 && (
        <Text>No matches in the searched chats.</Text>
      )}
      {matches.map((match) => (
        <Pressable
          accessibilityRole="button"
          key={`${match.source}:${match.threadId}`}
          onPress={() => onOpen(match, computer)}
          className="gap-1 rounded-lg bg-subtle p-3"
        >
          <Text className="font-t3-medium text-foreground">{match.title}</Text>
          <Text className="text-xs text-foreground-muted">
            {computer.label} · {match.source === "t3" ? "T3" : "Codex app"} ·{" "}
            {new Date(match.updatedAt).toLocaleDateString()}
            {match.archived ? " · Archived" : ""} · Read-only
          </Text>
          <Text className="text-sm text-foreground-muted">{match.snippet}</Text>
        </Pressable>
      ))}
      {search.data?.nextT3Offset != null && (
        <Pressable
          accessibilityRole="button"
          disabled={search.isPending}
          onPress={() => {
            setPrevious(matches);
            setHadMissingHistory(
              hadMissingHistory ||
                search.data!.coverage.some(
                  (coverage) => coverage.readGaps === true || coverage.status === "unavailable",
                ),
            );
            setT3Offset(search.data!.nextT3Offset!);
          }}
          className="min-h-11 justify-center"
        >
          <Text>Show more T3 matches</Text>
        </Pressable>
      )}
      {search.data?.nextCodexCursor && (
        <Pressable
          accessibilityRole="button"
          disabled={search.isPending}
          onPress={() => {
            setPrevious(matches);
            setHadMissingHistory(
              hadMissingHistory ||
                search.data!.coverage.some(
                  (coverage) => coverage.readGaps === true || coverage.status === "unavailable",
                ),
            );
            setCursor(search.data!.nextCodexCursor!);
          }}
          className="min-h-11 justify-center rounded-lg border border-border p-3"
        >
          <Text>Search more Codex chats</Text>
        </Pressable>
      )}
    </View>
  );
}

function ChatReader({
  selected,
  onBack,
}: {
  selected: { match: ChatHistoryMatch; computer: Computer };
  onBack: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const read = useEnvironmentQuery(
    orchestrationEnvironment.chatHistoryRead({
      environmentId: selected.computer.environmentId,
      input: { source: selected.match.source, threadId: selected.match.threadId, offset },
    }),
  );
  return (
    <View className="gap-3">
      <Pressable accessibilityRole="button" onPress={onBack} className="min-h-11 justify-center">
        <Text>Back to results</Text>
      </Pressable>
      <Text className="font-t3-medium text-foreground">
        {read.data?.title ?? selected.match.title}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {selected.computer.label} · Read-only. This view does not resume or change the chat.
      </Text>
      {read.isPending && <Text>Opening chat...</Text>}
      {read.error && (
        <Text accessibilityRole="alert">
          This chat could not be opened. The computer may be disconnected.
        </Text>
      )}
      {read.error && (
        <Pressable
          accessibilityRole="button"
          onPress={read.refresh}
          className="min-h-11 justify-center"
        >
          <Text>Retry opening chat</Text>
        </Pressable>
      )}
      <Text className="text-sm text-foreground-muted">Matched text: {selected.match.snippet}</Text>
      {read.data?.truncated && (
        <Text>Long messages on this page are shortened to 8,000 characters.</Text>
      )}
      <View className="flex-row gap-3">
        {read.data?.nextOffset != null && (
          <Pressable
            accessibilityRole="button"
            disabled={read.isPending}
            onPress={() => setOffset(read.data!.nextOffset!)}
            className="min-h-11 justify-center"
          >
            <Text>Older messages</Text>
          </Pressable>
        )}
        {offset > 0 && (
          <Pressable
            accessibilityRole="button"
            disabled={read.isPending}
            onPress={() => setOffset(Math.max(0, offset - CHAT_HISTORY_MESSAGE_PAGE_SIZE))}
            className="min-h-11 justify-center"
          >
            <Text>Newer messages</Text>
          </Pressable>
        )}
      </View>
      {read.data?.messages.map((message) => (
        <View key={message.id} className="gap-1 border-t border-border py-3">
          <Text className="text-xs text-foreground-muted">
            {message.role === "user" ? "You" : "Assistant"}
            {message.createdAt ? ` · ${new Date(message.createdAt).toLocaleString()}` : ""}
          </Text>
          <Text selectable className="text-sm text-foreground">
            {message.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ChatHistorySearch({ computers }: { computers: ReadonlyArray<Computer> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [computerId, setComputerId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{
    input: ChatHistorySearchInput;
    computerId: string | null;
    revision: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ match: ChatHistoryMatch; computer: Computer } | null>(
    null,
  );
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        className="mx-4 min-h-11 justify-center rounded-lg bg-subtle px-3"
      >
        <Text className="font-t3-medium text-foreground">Search all chats</Text>
      </Pressable>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView className="flex-1 bg-screen">
          <View className="flex-row items-center justify-between px-4">
            <Text className="text-lg font-t3-medium text-foreground">Search chats</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              className="min-h-11 justify-center px-3"
            >
              <Text>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 16, gap: 12 }}
          >
            {selected && (
              <ChatReader
                key={`${selected.computer.environmentId}:${selected.match.source}:${selected.match.threadId}`}
                selected={selected}
                onBack={() => setSelected(null)}
              />
            )}
            <View style={{ display: selected ? "none" : "flex", gap: 12 }}>
              <Text className="text-sm text-foreground-muted">
                Find T3 and Codex app chats, including archives.
              </Text>
              <Text>Chat name or message text</Text>
              <TextInput
                accessibilityLabel="Chat name or message text"
                value={query}
                onChangeText={setQuery}
                maxLength={200}
                autoCapitalize="none"
                className="min-h-11 rounded-lg border border-input-border bg-input px-3 text-foreground"
              />
              <Text>Computer</Text>
              <View className="flex-row flex-wrap gap-2">
                {[{ environmentId: null, label: "All computers" }, ...computers].map((computer) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: computerId === computer.environmentId }}
                    key={computer.environmentId ?? "all"}
                    onPress={() => setComputerId(computer.environmentId)}
                    className="min-h-11 justify-center rounded-lg border border-border px-3"
                  >
                    <Text>
                      {computerId === computer.environmentId ? "✓ " : ""}
                      {computer.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text>From date</Text>
              <TextInput
                accessibilityLabel="From date, YYYY-MM-DD"
                placeholder="YYYY-MM-DD"
                value={from}
                onChangeText={setFrom}
                autoCapitalize="none"
                maxLength={10}
                className="min-h-11 rounded-lg border border-input-border bg-input px-3 text-foreground"
              />
              <Text>Through date</Text>
              <TextInput
                accessibilityLabel="Through date, YYYY-MM-DD"
                placeholder="YYYY-MM-DD"
                value={through}
                onChangeText={setThrough}
                autoCapitalize="none"
                maxLength={10}
                className="min-h-11 rounded-lg border border-input-border bg-input px-3 text-foreground"
              />
              <Text className="text-xs text-foreground-muted">
                Dates use this device's calendar. Text searches messages sent during the date range,
                or chat names updated during it.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  try {
                    const input = chatHistoryDateInput(query, from, through);
                    setSubmitted({ input, computerId, revision: (submitted?.revision ?? 0) + 1 });
                    setError("");
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Check the dates.");
                  }
                }}
                className="min-h-11 justify-center rounded-lg bg-subtle px-3"
              >
                <Text>Search chats</Text>
              </Pressable>
              {error && <Text accessibilityRole="alert">{error}</Text>}
              {computers.length === 0 && <Text>Add a computer to search its chats.</Text>}
              {submitted &&
                computers
                  .filter(
                    (computer) =>
                      !submitted.computerId || submitted.computerId === computer.environmentId,
                  )
                  .map((computer) => (
                    <ComputerResults
                      key={`${submitted.revision}:${computer.environmentId}`}
                      computer={computer}
                      input={submitted.input}
                      onOpen={(match, computer) => setSelected({ match, computer })}
                    />
                  ))}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
