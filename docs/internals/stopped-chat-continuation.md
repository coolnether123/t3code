# Stopped-chat continuation

An opted-in local server can ask the existing permission service whether the
user already requested the action in the agent's final question. The service
receives only the last 15 genuine user messages and that final output. File
instructions, earlier assistant messages, tools and memory are not authority.

The existing provider command reactor queues completed messages and ready
sessions into a separate drainable worker. The permission service owns the
typed judgment, source citation, protected-action rules and spend cap. A
missing citation, held action or unavailable service leaves the chat unchanged.

Delivery uses the ordinary `thread.turn.start` message path. Its serialized
decider checks the stopped turn, hash of genuine user history, final assistant
message id and question hash again before persisting events. A newer human
message, a changed question, a queued reply, an open platform request or a
running turn rejects delivery. The stable command and message ids make a
repeated delivery idempotent. Tagged messages cannot become fresh authority.
Two continuations per genuine-human revision are allowed. A second requires a
completed tool activity in the latest turn. Native hook feedback prevents a
second delivery path from continuing the same turn.

The local opt-in marker is `~/.codexdeck/jev_t3_enabled`. The server must use
the exact `~/.t3` home. A disposable test home cannot read the live credential
or call the live permission service. The marker does not change the service's
own kill switch. The bridge never answers a provider approval request.

The attribution tag identifies an automated application of an earlier
instruction. It is not a fresh human confirmation. Browser action-time
financial or sensitive-data gates still require a person. Financial actions
without observed duplicate proof remain held by the shared service.

Private audit rows distinguish dispatch intent, persisted message and a reply
left for the user. A persisted message alone does not prove provider execution
or client rendering. Integration tests use synthetic threads and provider
stubs, not an account's conversations.

The authority/hash module and local-service adapter are intentional boundaries.
Keep them separate from the reactor even where a helper has one production
caller. The decider and delivery worker must use the same authority definition.
