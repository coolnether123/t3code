# Reconcile a duplicated reply

Codex completed items contain the original full reply. T3 uses that text when completing an unsegmented assistant message, rather than trusting accumulated delivery fragments. This applies to buffered and legacy streaming delivery. Approval-separated segments retain their boundaries. Providers without original completed text keep their existing behavior.

For a damaged saved reply, use `chatHistory.reconcileReply` with orchestration operate scope. Supply the existing T3 thread ID, exact native turn and message IDs, and SHA-256 fingerprints of both the reviewed native reply and current projection text. Do not send reply text to this route.

The server reads only the native conversation already bound to that T3 thread. It requires a completed native turn and an existing non-streaming assistant message with the exact native item identity and turn. Both fingerprints must match. The serialized command checks the saved text again and refuses an active chat. No user message, turn request or approval decision is sent.

The native binding uses the session's provider thread ID first. If a restarted session has no transient ID, it uses the exact string thread ID in its persisted Codex resume cursor. Invalid, missing or foreign-provider cursors are rejected. Deleted chats and projects remain excluded. It never matches names or reply text to choose a conversation.

The accepted command replaces that message's display text through the normal event store and projectors. Its metadata records `operatorReconciliation` and `historyImport`, so the agent-awareness relay does not interpret the correction as new instructions. Original events remain intact. Read back the exact saved text before any retry. A stable command ID makes an identical accepted command replay safe; a changed projection fails closed.

Use private local evidence for original text and native readback. Reports contain only counts, IDs and fingerprints. Never guess identities or remove repeated phrases heuristically: repeated words can be intentional.

Keep the previous application or backend and the checkpointed APFS database clone from the guarded install. For a code rollback, restore the previous launcher and code only after all agent turns and sending replies stop. Keep the newer live database; do not replace newer conversations with the old clone.
