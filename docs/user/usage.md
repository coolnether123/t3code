# Review usage

For a birthday palette and tap effects on these screens, see [Celebrate your birthday](birthday-theme.md).

The Usage page combines Codex, Claude Code, Gemini, OpenCode, and configured chat archives from
your connected environments. It reads local history and shows API-equivalent token cost, processed
tokens, cache savings, provider shares, and model breakdowns. Subscription billing is separate from
the raw token cost shown here.

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

## Understand API estimates

Recorded dollar costs take precedence over token estimates. Otherwise, Usage applies the latest
cached model prices at standard text-token rates, including each request's context-length tier.
Provider namespaces are kept separate: a reseller's rate cannot replace a direct provider's rate.
Unknown models and missing rates are marked unpriced, not treated as free usage. Reasoning tokens
already included in output are not charged twice.

These are current-price equivalents, not historical invoices. They do not reconstruct fast,
flex, batch, regional, or negotiated pricing. Cache-write estimates use the standard short-lived
cache rate; storage duration, long-lived cache premiums, audio/image-specific rates, and tool fees
are not reconstructed from token totals. Provider-reported costs may themselves be estimates from
the local harness. A subscription's quota percentage is not a dollar balance.

### Import product chat archives

Configured ChatGPT and Google AI Studio exports appear as **ChatGPT archive** and **AI Studio
archive**. Raw chat text stays on the environment that reads it. Only aggregate token and cost
buckets cross the T3 connection.

ChatGPT exports retain message dates and model names but do not include an API token ledger. Usage
estimates each message from its text, reconstructs the parent context for each assistant response,
and places the result on the original message date. Reimporting an overlapping export does not count
the same conversation message twice.

AI Studio exports include per-message token counts but omit the original chat date and request-level
usage ledger. Usage reconstructs the input context for each model turn and uses the downloaded
file's timestamp on the graph. A notice stays visible while this source contributes. Exact duplicate
files are counted once by content; separate branches remain separate chats.

Imported product chats are API-equivalent estimates, not proof of API charges. Unknown experimental
models remain unpriced when no documented paid equivalent exists.

## Monitor Codex usage

Open **Codex usage & resets** from Usage. You can also tap or hold the **Codex icon/name**,
or tap **Usage & resets →** below its row. **Usage** in the header takes you back.
Scrolling cancels the hold gesture. Enter and Space activate the focused Codex button.

The monitor leads with remaining usage and the total used in the current account cycle.
For example, 81% remaining means 19% used. If tracking began at 83%, the monitor observed
a two-percentage-point drop. Those two points are not the cycle total.

**Recorded** shows saved readings. **To reset** adds the current-pace projection and a target
that leaves 3% unused. The forecast blends the observed pace with the current weekly average.
Earlier cycles do not influence it. Gaps over an hour are not joined.

Turn **Recent pace** on or off beneath the chart to compare a second, cyan projection.
It uses the time between the last two observed percentage drops, expressed as time per 1%.
If fresh readings show the next drop is taking longer, that longer wait sets the pace instead.
For example, a last interval of 10 minutes becomes 25 minutes per 1% after 25 minutes with no
further drop. Another drop starts the timing again. A drop of several points uses the interval's
average time per point; the tracker cannot see the individual drop times between readings.

The caption shows the completed interval, the wait through the latest reading, and the timing
used for the projection. Before two drops are observed, a confirmed wait after the first drop
can provide a provisional pace. An unchanged initial balance alone cannot establish the time
of a drop. Resets and observation gaps over 15 minutes restart timing, and stale readings stop
the projection. Clock time without a fresh account reading does not count as confirmed waiting.
Neither line changes measured usage or predicts future workload. Rounded readings make drop
times approximate, and an unchanged percentage does not mean zero usage.

An earlier public reset announcement changes the planning deadline, not your account balance.
The original weekly timer stays under **Source and weekly timer**. Announcements come from
Tibo's public posts through the independent Reset Beacon feed. The source link and time
interpretation remain visible. A missing or expired announcement falls back to the account timer.
A countdown reaching zero never creates a reset observation or changes usage to 100%.

The page checks readings every minute and public news every five minutes while open.
The separate Codex Limits collector records every five minutes while its computer is awake
and signed in, even with T3 closed. Readings older than 15 minutes are labeled stale.
News requests send no account credentials, usage totals, or chat data.

Press **Refresh** to reload saved readings, refresh public reset news, and check API costs for
the newly read interval. The button shows progress and ignores repeated taps until it finishes.
Unchanged transcripts keep their cached records. On the mobile app, pulling down does the same.
Growing chats read only their appended text when the saved cursor is valid. Public reset news
updates independently and does not hold the usage refresh open.
Refresh does not force a new collector sample or run Luna. Use **Check X with Luna** separately.

The view starts with the latest continuous monitoring run. A gap over 24 hours begins another
run. Older samples remain saved, but do not appear here or enter its dollar comparisons.
**Resets while monitored** fills as new account readings show usage returning. The observation
interval is not an exact reset timestamp. A banked reset or account change can look similar.

### Check reset announcements with Luna

Press **Check X with Luna** on **Codex usage & resets**. The selected quota-source computer
runs a Codex Luna check with live web search. It uses that computer's Codex sign-in and allowance.
The status changes while the check runs. **Cancel** stops it; checks stop after three minutes.
Leaving the page does not cancel the job. Returning shows its latest status and saved result.

Results include source links, a check time, confidence in the proposed timing, and a date/time
range when the announcement is ambiguous. Times use your device's time zone. A saved result
is not a live feed; press the button again for updates.

X may block access to its current feed. In that case the result explicitly says **Latest X feed
not verified**, even when search results or an archive contain an announcement. Indirect evidence
cannot receive high confidence. Failed access is not evidence that no reset is coming.

The check does not change your quota, account timer, or planning deadline. The existing public-news
feed supplies the planning deadline, and account readings confirm actual resets. The button is
Codex-only and requires a connected, updated T3 server with Codex installed and signed in.

### Read community discussion with Luna

Under **What people are saying**, press **Check community with Luna**. This is a separate job
from the announcement check, with its own running status, cancel button, and saved result.
It uses Codex allowance only when pressed and stops after three minutes. Leaving the page
does not stop it. The controls and linked posts work on mobile too.

Luna returns up to six X posts with summaries, authors, timestamps when verified, and labels
for reset reports, people still waiting, questions, speculation, or other reactions. Individual
reports do not confirm your reset and never change your quota or planning deadline.

The result states whether it read live posts or only partial evidence. X can block current
replies or require sign-in; a saved or indexed post is not a complete live feed. Failed access
is shown as unavailable, not as evidence that nobody is discussing the reset.

### Understand the dollar estimate

**Used while monitored** prices Codex transcripts from the same observed interval.
**Value of usage remaining** uses that cost per observed percentage point. It shows **Learning**
until at least five points have been observed. The full cycle total cannot calibrate a shorter
transcript interval. Spark is excluded because it has a separate quota.

Dollar values are API-equivalent estimates, not subscription bills, cash balances, or credits.
Model mix and missing history affect them. Incomplete scans, missing prices, and unavailable
computers withhold the estimate. A previous complete calculation is labeled with its time.

Expand **Tracking and computers** to choose the quota source and computers for cost comparison.
Select computers using the same Codex account. Percentages are never added across machines.
The tracker does not verify account identity or identify chats copied between distinct sources.
The power monitor is separate and does not contribute to Codex quota totals.
