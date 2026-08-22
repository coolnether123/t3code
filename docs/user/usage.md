# Review usage

The Usage page combines Codex, Claude Code, Gemini, and OpenCode activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, **90 days**, **120 days**, and **1 year** ranges use daily resolution. Cost and token
toggles update both the headline and chart, and refreshing rescans every connected environment.

Parsed transcripts are cached individually on the environment that owns them. Expanding to a range
that has not been viewed before may briefly warm older history; afterward, unchanged chats reuse
their cached records and only new or edited transcript files are parsed again.

Usage history is independent from the providers enabled for new T3 Code chats. Disabling Claude
Code or leaving Gemini unavailable as a chat provider does not remove their locally stored history
from Usage. Gemini totals include Gemini CLI sessions and locally recorded Antigravity token totals.
OpenCode totals come from its local session database and remain available when OpenCode is disabled
as a provider for new chats.
