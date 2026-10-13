# Retire stale approvals without answering them

Use the authenticated orchestration dispatch route or `t3 agent act` with
`thread.approval.retirement.set`. This command retires or restores one existing
unanswered request. It never calls a provider, records a decision, submits a
message, unarchives a chat, or starts a turn.

Before retiring, read the exact request, archive state and provider conversation.
An archived chat or completed work establishes staleness. A stopped session alone
does not establish that the underlying business decision is no longer needed.

The command contains `commandId`, `threadId`, `requestId`, `retired` and
`createdAt`. Set `retired: true` to retire, or `retired: false` to restore.
Use a new command ID for restoration; reuse the original command ID only when
reconciling an uncertain attempt. Read back the request before retrying.

The server rejects active sessions, active turns, queued starts, answered or
missing requests. Retirement also rejects chats that are neither archived nor completed. Restoration
requires a recorded retirement, not an ordinary resolved approval. The original
request context stays in the event store. Retirement and restoration emit
operator-attributed activities with `decisionSent: false`. Replaying those events
rebuilds the same pending state. Neither operation removes the chat or its history.

Retired requests cannot be answered until restored. Restoring an archived request
does not unarchive its chat or recreate a provider callback. If an unarchived
interrupted chat's callback is gone, answering uses the existing durable delivery
route: read the exact bound conversation, deliver its saved decision once, and
queue a turn in that same conversation. Do not answer on the user's behalf to
test this behavior on a real account.
