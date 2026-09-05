# Usage and limits

## Understand your usage

**Usage** combines Codex, Claude Code, Grok Build, Gemini, OpenCode, and imported chat history from your connected
environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost. These estimates are not your subscription bill.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** shows quota use and reset times for Codex and Claude subscriptions. It also
compares quota consumed with time elapsed in each window, so you can judge your pace before the
next reset.

If a window looks stale, refresh Limits to re-check every provider and hub.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

For birthday colors and tap effects, see [Celebrate your birthday](birthday-theme.md).
For Fast Mode and service-tier estimates, see [Codex Fast Mode usage](codex-fast-mode-usage.md).

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
On Windows, the separate Codex Limits collector records every five minutes while its computer is
awake and signed in, even with T3 closed. On macOS, T3 asks the signed-in Codex desktop daemon for
a reading when reset history is requested and throttles that request to once every five minutes.
Direct CLI mode reads quota through its configured Codex app-server transport. Readings older than 15
minutes are labeled stale. News requests send no account credentials, usage totals, or chat data.

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
