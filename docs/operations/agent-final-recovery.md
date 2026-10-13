# Display an existing agent final

`chatHistory.attachFinal` copies a completed native Codex turn's last agent
message into its existing T3 thread. It does not resume a session, send input,
answer an approval or change a pending question.

Use this operator-only recovery path only when the user has authorized showing
the already-produced reply. The RPC requires `orchestration-operate` and accepts
the T3 thread ID, native turn ID and reviewed SHA-256 of the exact final text.
It does not accept replacement text or a caller-selected native thread.
The server resolves the native thread from the existing T3 session binding.

The server reads turn metadata and persisted items through the Codex daemon,
requires a completed turn and checks the text fingerprint before dispatch.
The serialized decider checks that no newer user message arrived during the
read. A stable message/command ID prevents duplicate copies.

The displayed assistant copy starts with:

> Otis operator copy, not from Christine. Existing agent reply, copied without sending instructions.

Everything after that label is the exact existing agent text. The attachment
has no turn ID. Event metadata records the native thread, turn and message,
`operatorAttachment: true` and `historyImport: true`. The provider reactor does
not run the stopped-chat judge for this event, and the awareness relay does
not treat it as new work. Existing clients display it through their ordinary
assistant-message renderer; no new user-facing control is introduced.

Keep the attachment receipt and verify its persisted assistant role, label,
exact text fingerprint and unchanged pending requests. A copied final is not
proof that the work described by that agent is complete.
