# Connection recovery

T3 retries temporary Codex connection failures before showing an error. If a
provider becomes unavailable, T3 checks it again in the background, even when
its chat is not open. A lost computer connection shows that T3 is trying again.
If a temporary status check fails, your last known models stay available while
T3 checks again. A slow Claude check also keeps its known models available.
If it needs your help, open Connections to reconnect the computer.

Provider and turn errors show a short explanation. Choose Show full error to see
the technical message. If your sign-in expires, sign in again in Settings.

T3 retries connection setup before sending a turn. It does not automatically
resend a turn whose delivery is uncertain. After an interrupted turn, check
the last reply before trying again so the assistant does not repeat work.
