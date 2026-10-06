# Chat history search

`chatHistory.search` and `chatHistory.read` are read-only WebSocket RPCs. Both
require `orchestration:read`. They use the existing environment connection and
authorization, including remote and relay connections. They do not import a
thread, create a project, resume a provider session or dispatch a command.

## Sources

`apps/server/src/chatHistory.ts` reads the existing T3 projection through
`ChatHistoryProjection`. The runtime supplies its existing SQLite connection.
Search includes archived threads, excludes deleted threads and projects, and
matches titles, user messages and final assistant messages referenced by turns.
Streaming messages and tool output are excluded. Literal `%`, `_` and `!`
characters remain literal SQL search text. Results rank title matches before
user messages, then assistant replies, with recent chats first within a rank.
T3 results page in groups of 50 through `t3Offset` and `nextT3Offset`.

`apps/server/src/provider/CodexChatHistory.ts` connects to the configured Codex
home's desktop daemon using `CodexDesktopDaemonTransport.ts`. It initializes a
scoped client and uses only `thread/list` and `thread/read`. No SQLite or rollout
file fallback serves Codex app history. The legacy `/api/codex` store routes
remain separate and unchanged.

The daemon's `searchTerm` filters titles only. Message search therefore reads
histories for pages of one thread, with one read in flight and a
15-second bound per read. A timed-out read retries once. A page therefore has
at most 30 seconds of history-read waiting within the 45-second RPC bound.
Active pages precede archived pages. The opaque
`codexCursor` contains the archive phase and native cursor. Each request closes
its client when it finishes. Search has a 45-second request bound; read has a
15-second bound. Neither operation launches or restarts a daemon.
Search alone allows daemon frames up to 512 MiB because tool-heavy histories
can exceed the WebSocket adapter's default 100 MiB limit. Normal provider
connections keep the default. Histories beyond that bound remain an explicit
coverage gap; no tool payload is sent to the search UI.

Codex search includes user text and assistant replies in completed turns. It
excludes tool output. Undated messages can match without a date filter. With a
date filter, undated matches cause an explicit coverage gap. Failed history
reads preserve matches from readable histories on the same page and matching
names returned by the daemon's list operation.

## Client behavior

Web and desktop expose **Search all chats** in the sidebar and command palette.
The native mobile home list exposes the same action, including the empty T3
list state. Search defaults to all known computers, independently of the
current sidebar filter. Each computer reports its own coverage and retry
action. Unsupported or disconnected servers never count as successful empty
searches.

Clients submit searches explicitly, then automatically follow Codex cursors.
Each computer has a stop/continue control. Stopping prevents further pages;
the current bounded request can finish. `advanceChatHistoryScan` shares result
retention, coverage-gap tracking and repeated-cursor protection between web and
mobile. T3 match pagination stays separate. The web fragment `#search-chats`
opens the dialog directly without submitting a search or changing authentication.
Clients append pages and deduplicate known
T3/Codex links through `projection_thread_sessions.provider_thread_id`. A Codex
history match wins over its linked projection match. Unrelated identical IDs
and chats on different computers remain distinct. There is no title-based
deduplication. `readGaps` from earlier pages stay visible after later pages
succeed. Pagination is a sequence of current reads, not a historical snapshot.

Dates use the client's local calendar. **From** is inclusive and **Through**
becomes the next local midnight, exclusive. The client accounts for
daylight-saving changes. Title matches use the chat's update time; message
matches use message time, or the containing Codex turn's start time.

The result reader is separate from the chat composer and normal thread routes.
It returns 50 messages per page, newest page first and chronological within a
page. Message text is capped at 8,000 characters and marked when shortened.
Older/newer controls page without resuming a session. Back to results retains
the searched pages. No chat contents are stored in a new index or on disk.

## Verification and limits

`apps/server/src/chatHistory.test.ts` uses migrated in-memory projections and a
synthetic WebSocket daemon. `apps/server/src/server.test.ts` includes a
disposable authenticated route test with command dispatch prohibited.
`apps/web/src/components/search/ChatHistorySearchDialog.test.tsx` checks
computer selection, missing coverage, deduplication, paging and read-only
opening through renderer fixtures. Contract and shared-state tests cover
input bounds, calendar dates, and identity rules.

These checks do not establish acceptance on a real Mac or phone. Native layout,
Mac daemon-version compatibility and account-specific live coverage still
need device acceptance. Only the configured default Codex desktop daemon is
searched, not every provider instance home. External chat histories for other
providers are not included, although their saved T3 projection chats are.
