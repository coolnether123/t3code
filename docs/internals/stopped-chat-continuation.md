# Stopped-chat continuation

Christine's local T3 backend can apply an existing chat request before calling
the permission judge. `stoppedChatJudge.ts` invokes the local Python matcher
through `readRequestedSave`. This one-caller helper is an intentional process
boundary so Desktop and T3 use one matcher.

The matcher gets only the agent's last message and genuine human messages with
timestamps. Its enable marker is `.codexdeck/requested_save_t3_enabled` in the
Mac user's home. It does not need the JEV enable marker, token or model service.
An unresolved decision falls through to the existing JEV path.

The persisted reply is `Yes, save it. You asked for this at <time>.` without a
JEV tag. `stoppedChatAuthority.ts` excludes that prefix from human authority and
counts it against the existing continuation limit. The decider requires the
exact known format and a fresh stopped-chat guard. Platform requests, changed
source revisions, duplicate native-hook feedback and held threads still block
delivery.

The private `requested_save_t3_deliveries.jsonl` ledger distinguishes intent
from persistence. Live acceptance requires both a persisted ordinary message
and its matched source citation. Synthetic fixtures do not prove live delivery.

Focused checks are `stoppedChatAuthority.test.ts`, the server typecheck and
the targeted lint. Install an exact source build through the guarded Mac
backend deployment route only after its live idle checks pass. Preserve the
current package version and the user's T3 data. Remove the independent enable
marker to disable this step without disabling JEV.

# Scheduled routine authority

The local requested-save step can cite Christine's scheduled routine prompt as
her standing request. `saveAuthority` contains that prompt plus human messages
in chat order; `humans` keeps its existing JEV provenance. Both sources bind the
serialized revision guard. This is not a fresh human action-time confirmation.
Later wait/review/withdrawal instructions and protected-action holds still apply.
