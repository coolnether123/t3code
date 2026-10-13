# Approval reply delivery

The approval response intent records the saved decision, not provider acceptance. The server claims one durable `approval_response_deliveries` row per thread and request. Repeated client intents cannot replace or resend that decision. Only a provider callback acknowledgement or exact conversation readback confirms delivery.

If the callback is stale, the reactor reads the bound provider conversation before enqueueing one T3-attributed message through the existing turn or steer route. Codex recovery requires an existing conversation identity and refuses a fork. Message text and command identity remain stable across restarts. Confirmation reads back with bounded delays of 0, 250 and 1000 milliseconds. A timeout after a possible send does not authorize another send.

Uncertain delivery retains the decision and emits one escalation. Startup recovers known-not-attempted work and reads back attempted message delivery. It re-emits missing terminal receipts with the same command identity. It never blindly repeats a callback or message whose acceptance is unknown.

Rollback restores only the previous code and launcher. Keep the additive table and saved replies. Do not replace the database with a pre-release snapshot over newer work.
