# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

When more than one environment is connected, choose the Mac at the top of the
sidebar. Projects, drafts, threads, and sidebar search show only that environment.
The new-thread button, its keyboard shortcut, and **New thread in...** use the
same choice, even if a chat from the other Mac is still open. Choose **All
environments** to browse both together. Switching environments returns to the
last thread or draft you had open there. If it is no longer available, T3 starts
a draft in that environment's most recently active project, or shows the project
setup screen when it has none. **All environments** keeps its own last chat
location and stays a combined view. Switching only changes which environment
the client shows. It does not change project files.

Open **Agent activity** above the project filter to see working threads and requests
that need you across your connected environments, even when the sidebar is filtered
to one Mac. Select a row to open its thread and see any subagents there. A disconnected
Mac's cached status is not counted as live work; the menu tells you when activity
from a disconnected Mac is unavailable.

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Search chats across computers

Choose **Search all chats** above the sidebar list on web or desktop, or at the
top of the chat list on your phone. You can also choose **Search all chats** in
the command palette. The list's **Filter list** field only filters the current
list; it does not search all chat history. On mobile, this filter is called
**Filter current chats**.

Enter a chat name or message text, choose one computer or **All computers**, and
optionally set **From** and **Through** dates. Choose **Search chats**. Leave the
text blank to browse by date. Dates use your device's calendar, including the
whole end date. Message matches use the message's date; chat-name matches use
the chat's last-update date.

Results show the computer, chat source, date and archive status. T3 searches its
saved chat names, user messages and completed assistant replies, including
archived chats. Codex app histories come from that computer's running Codex app
daemon. Use **Search more Codex chats** to search the next page, including
archived app chats after the active pages. A linked T3 chat and Codex app chat
appear once when both match.

Open a result to read it without resuming, importing or changing the chat. Use
**Older messages**, **Newer messages** and **Back to results** to navigate. Long
messages may be shortened; the reader tells you when this happens.

Each computer reports its search coverage. A disconnected computer, older T3
server, unavailable Codex daemon, unreadable history or missing message date can
leave results incomplete. **No matches** means no matches in the chats searched
so far. Tool output, deleted chats and chats from other apps are not included.
T3 returns matching chats in pages of 50. Use **Show more T3 matches** for the
next page. Use **Retry this computer** after a connection recovers.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a pinned or active thread's menu and choose **Move up** or **Move down**. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. Changes apply to connected environments that support shared settings;
offline environments and older servers keep their previous values. If connected
environments disagree, **Apply to all** copies your current settings to those named
in the warning. Changing a rule does not reopen already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
