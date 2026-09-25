# Review usage

For a birthday palette and tap effects on these screens, see [Celebrate your birthday](birthday-theme.md).

The Usage page combines Codex, Claude Code, Gemini, OpenCode, and configured chat archives from
your connected environments. It reads local history and shows API-equivalent token cost, processed
tokens, cache savings, provider shares, and model breakdowns. Subscription billing is separate from
the raw token cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, **90 days**, **120 days**, and **1 year** ranges use daily resolution. Cost and token
toggles update both the headline and chart, and refreshing rescans every connected environment.

In **Hourly model usage**, each bar shows processed tokens for Astra, Sol, Luna, Terra, or another
recorded model. Select an hour to see its token total and estimated dollar cost; token totals include
cached input, and empty hours remain visible so the timeline stays accurate.

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

## Review repeated input

Open **Skills & repeated input** beside Usage in the sidebar to inspect attribution on its own
page. On mobile, open it from Settings. Use **Usage** in the header to return to your usage totals.
The attribution page has its own period and computer selectors. Its refresh reads transcript
metadata for the selected period.

Compare direct tokens, occurrences, or estimated value by source kind, model, computer and project,
or time. Select a bar to inspect its breakdown. Search the tracked payloads or filter by **Skills**
and evidence level, then expand a row for its model costs and observation details. Payload filters
affect the list; the overview and comparison retain the full selected period and computer scope.

The **Current skills** catalog lists every `SKILL.md` revision discoverable on the selected
computers, including skills with no transcript evidence in the selected period. Use its search,
observation filter, sorting, and paging controls to distinguish **Observed** from **Never observed**
skills. A never-observed skill keeps its current file hash, size, and tokenizer count when available,
but has no invented dates, confidence, tokens, or dollar value. Historical observed revisions remain
available in the separate payload history even after the current file changes.

The first source is local Codex session transcripts. Skills are checked first, including
`SKILL.md` files such as `unslop`. Other typed sources can include AGENTS or instruction files,
named reusable developer blocks, and repeatable tool-operation payloads. Ordinary repeated chat
text is not treated as a reusable operation.

Each item shows its display name, source kind, stable content hash, file revision or hash when one
exists, first and last observation, occurrence count, affected sessions and turns, and confidence.
The page keeps these confidence levels separate:

- **Reference** means a transcript names the file or source.
- **Likely read** means the record supports a read but does not contain the complete payload.
- **Confirmed read** means the complete repeated payload was observed and can be attributed.

Direct payload input is separate from the full input reported for an affected session or turn. A
session that loaded a skill can contain other instructions, history, tool output, and user input.
The page never labels that full session total as the skill's cost.

Token attribution shows exact, estimated, cached, cache-write, and unknown values when the source
provides them. The model rows use the same current pricing table and pricing revision as the rest
of Usage. Provider-reported cost wins. An unknown model, missing price, malformed record, or
missing tokenizer remains **Unpriced**, not `$0.00`.

After a transcript contains a confirmed complete skill payload, later model turns in the same
carried context attribute that skill again. T3 labels the skill tokens **Cached** or **Cache write**
only when the provider's complete request partition proves that placement. If a request mixes
cached and uncached input, the skill remains **Unknown** because request-level totals cannot prove
where that payload landed. Context resets, compaction, and forks end the carried attribution.

When a range mixes priced and unpriced models, the combined number is the priced subtotal and is
marked incomplete. It does not assign a zero-dollar value to the remaining input.

Every dollar value on this page is labeled as an API-equivalent estimate. It is an
estimate of what the recorded tokens would represent at the selected API rates. It is not a
charge, subscription balance, or reset consumption. The page can group totals by item, source
kind, model, project or environment, and date when those aggregates are covered by the scan.

Raw transcript text stays on the environment that read it. Only fingerprints, aggregate token and
value data, provenance, and coverage gaps cross the connection. The importer reuses the transcript
cache and cursor. Unchanged files are not reparsed, and an appended transcript reads only its new
records when the saved cursor is safe. File edits, forks, and retries invalidate the affected
cache entry and use stable record identities so the same occurrence is not counted twice.

If several historical file revisions share one display name, an exact path identifies the matching
revision. Name-only evidence stays unattributed rather than being multiplied across every revision.

The coverage notice names records that are too large, malformed, unavailable, missing a model or
tokenizer, or impossible to assign to one repeated payload. Those records stay visible as unknown
or uncovered data. Usage does not invent a token count or a price to fill the gap. Long ranges
render aggregate rows first; expanding an item loads only its saved metadata, never raw transcript
text.

Repeated-input attribution is additive. Enabling it does not change the normal Usage token buckets,
model pricing, API-equivalent totals, or the separate Codex usage-and-reset calculations.

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

If a computer disconnects before its first quota reading, the page shows **Reconnecting**
instead of continuing to say it is reading usage. A slow first reading also prompts you to
check the computer connection or reload the page. Public reset news can still load separately.

The monitor leads with remaining usage and the total used in the current account cycle.
For example, 81% remaining means 19% used. If tracking began at 83%, the monitor observed
a two-percentage-point drop. Those two points are not the cycle total.

**Recorded** shows saved readings. **To reset** adds the current-pace projection through the
planning deadline. The daily budget leaves 3% unused. The forecast blends the observed pace
with the current weekly average.
The chart colors saved readings and the filled area green ahead of weekly pace and red behind it. A dashed line shows
even weekly spending. Tracking gaps use API-weighted estimates when complete priced activity is available. Otherwise,
straight lines join saved readings, including
earlier monitoring runs in the same cycle. These lines show the change between readings without
claiming when it happened. Reset changes remain separate, and gaps do not become measured activity.

Use the previous and next arrows above the chart to browse saved reset cycles one at a time.
**Current** returns to the live cycle. Completed charts end at the first reading confirming the
next reset, and their pace line reaches zero at that boundary. The active cycle keeps the scheduled
planning deadline until a reset is observed. Past cycles show recorded balances, dates and the interval
in which the next reset was observed. Current forecasts and banked reset counts stay with the live
cycle. Only cycles retained in the saved account history are available.

Expand **Forecast details & readings** to inspect readings or turn **API cost pace** on or off to compare the blue projection.
It divides API-equivalent spending from the last six hours by elapsed hours, including idle
time. If monitoring began more recently, it uses that shorter interval, with at least one hour
required. Only the current cycle and selected computers contribute. The server measures costs
after the interval start through the latest account reading, using the same pricing and
source deduplication as the remaining-value estimate.

Estimated time to empty is remaining API value divided by average dollars per hour. For
example, $50 remaining at $10/hour gives five hours. The caption shows the measured window,
hourly cost, and outcome; **API value runs out** gives its projected timestamp. The blue line
maps the declining dollar balance onto the chart's remaining-percentage scale and stops at
zero. A complete zero-cost interval produces a flat line with no exhaustion timestamp.

Expand **Runway plan** for downtime planning. It turns that projection into downtime. It shows how long usage would be
unavailable before the account's scheduled reset if the measured dollar burn continues. Choose
the **maximum time without usage** you can tolerate; 12 hours is the default. The planner also
calculates the maximum average dollars per hour that would reach zero at that deadline. A lower
burn keeps usage available longer, while a higher burn exceeds the selected downtime limit.
Elapsed time since the last reading is charged at the measured rate, so the estimate advances
without waiting for another chart sample. If the rate is zero, the planner says usage lasts to
the reset rather than inventing an exhaustion time.

Stale readings, incomplete or unpriced costs, and a missing remaining-value estimate withhold
the blue projection. Elapsed clock time does not count as newly measured spending. The orange
line retains its percentage-based estimate for comparison. Model changes can affect Codex
allowance differently, so neither line guarantees future capacity or changes measured usage.

An earlier public reset announcement changes the planning deadline, not your account balance.
The original weekly timer stays under **Source and weekly timer**. Announcements come from
Tibo's public posts through the independent Reset Beacon feed. The source link and time
interpretation remain visible. A missing or expired announcement falls back to the account timer.
A countdown reaching zero never creates a reset observation or changes usage to 100%.

**Estimated use between public resets** uses the historical announcements published by
[Codex Resets](https://codex-resets.com/). T3 treats consecutive regular announcements as
approximate boundaries and totals the Codex transcript records stored on the selected computers
between those times. Each completed period shows its current-price API-equivalent value and a
per-model token and cost breakdown when the scan is complete.

This backfills estimates for periods before local percentage monitoring began, but it does not
backfill account usage percentages. Announcement time can precede account propagation, public
announcements are global rather than account-specific, and missing local transcripts are not zero
usage. Banked reset grants remain visible as context but never split a period because the user
chooses when to redeem them. T3 sends Codex Resets no account credentials, usage totals, chat data,
or transcript content.

The page checks readings every minute and public news every five minutes while open.
The separate Codex Limits collector records every five minutes while its computer is awake
and signed in, even with T3 closed. Readings older than 15 minutes are labeled stale.
News requests send no account credentials, usage totals, or chat data.
Saved quota history and completed cost snapshots survive page navigation and server restarts,
with bounded retention. Chart readings support hover, tap, and keyboard inspection.

Press **Refresh** to reload saved readings and public reset sources, then check API costs for the
newly read and backdated intervals. The button shows progress and ignores repeated taps until it
finishes.
Unchanged transcripts keep their cached records. On the mobile app, pulling down does the same.
Growing chats read only their appended text when the saved cursor is valid. Public reset news
updates independently and does not hold the usage refresh open.
Refresh does not force a new collector sample or run Luna. Use **Check X with Luna** separately.
Long windows such as **90 days** and **120 days** warm in bounded transcript batches while the
page remains open. If every selected computer fails to return a result, the window is shown as
**Unavailable** rather than as zero usage.

The view uses the latest continuous monitoring run for current measurements. A gap over 24 hours
begins another run. Older samples remain saved and appear in **Reset history**. When a new cycle
has too little current data to calibrate a pace or dollar value, the monitor may show a provisional
estimate based on the immediately preceding completed cycle. It includes that cycle's local date
range and is replaced automatically when current-cycle calibration is valid. Percentages are never
combined across reset boundaries. The observation interval is not an exact reset timestamp. A banked
reset or account change can look similar.

Each completed reset can be expanded to show input tokens, output tokens, and API-equivalent value
for every recorded model. Input includes cached and cache-creation tokens; reasoning tokens are
already included in output. Short-lived account-window switches that return to the original timer
are ignored so they do not split one real cycle into several resets.

The authenticated `server.getUsageSummary` query can narrow results to exact providers, native
session IDs, or native turn IDs. Callers may group returned buckets by model, session, or turn.
Environment identity remains the connection target, and every response retains each physical
source fingerprint and coverage status. Filters are bounded to 128 native IDs and never return raw
transcript text.

`costUsd` is API-equivalent value. `providerReported` means the provider supplied that request's
cost, `modelPriced` means T3 calculated it from the rate document identified by
`pricing.revision`, and `unpriced` keeps tokens while adding no dollars. None of these fields claims
the amount charged for a subscription. Account allowance remains in the separate quota history.

The runway baseline uses the account timer. **Banked manual resets** are shown separately and
never get added to the current balance or treated as an extension of the current timer. A full
manual reset refreshes both the short and weekly windows and starts a new approximately seven-day
window. The planner can show each credit's expiry and whether it remains available at the
estimated empty time when the connected account snapshot supplies expiry dates. Current saved
snapshots may provide only the verified count and check time, in which case expiry eligibility
is left unknown. If you redeem one, wait for the next account reading before planning the new
window; the planner never redeems credits for you.

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

The web monitor puts the chart first. Use the header links to jump to API value,
the token planner, Reset history, or Luna research. Expand **Inspect recorded readings** to scrub
through the saved observations with a pointer or arrow keys.

Drag across the quota graph to zoom into a period, or choose **24h**, **6h**, or
**1h**. The plus and minus buttons change the zoom; the arrows move through time.
**Full cycle**, Escape, or a double-click restores the whole chart. These controls
work on past reset cycles too. The percentage axis expands when zoomed.

**Where usage went** offers Intensity, Models, and Spikes views. Models splits bars
by model and shows cost shares; Spikes ranks intervals by hourly spending. Tap a bar,
use the arrow keys, or choose a spike to inspect costs, models, and estimated quota use.
Drag across the bars to zoom the quota chart to the selected time. Double-click or press Escape
to reset, or use **Zoom here** to open one interval. The bars fill the recorded time rather
than leaving room for the future projection. All controls work without hovering.
The summary compares peak and average spending, including idle time, and shows
what fraction of cost came from the busiest 25% of the selected time.

**Which burn did the readings follow?** checks non-overlapping six-hour windows in the full
cycle. It compares the orange blended forecast and the API spending pace available at the start
of each window with the next recorded quota reading. The API pace converts priced spending to
quota points using at least five points of earlier measured use. The tracker counts wins, ties
within half a quota point, and average misses. It skips resets, missing costs, and stale or
missing readings. It is a historical comparison, not a guarantee that API dollars measure quota.

The compact tracking layout keeps quota, API spending per hour, and the top model
hourly rates together. Model rates use the same visible interval, including idle
time. Expand **Inspect interval** for the selected interval or **All models** for
the remaining models. Forecast explanations and planning stay collapsed until needed.

**Compare cycles** shows how the selected cycle differs from an earlier saved cycle.
Expand it and choose any older cycle to overlay quota used and compare API value per
hour, total API value, input cache hit rate, and output tokens per hour. The comparison
uses equal durations from each cycle's first saved reading, limited by the shorter
recorded cycle. These starts may be later than the actual resets. Quota endpoints
between readings are interpolated; gaps do not prove when usage occurred.

The takeaways identify changes in spending pace, caching, and the model with the
largest hourly cost change. Expand **Model changes** for every model, including ones
only used in one window. Transcript comparisons load when opened and use the same
selected computers on both sides. Incomplete or unpriced costs withhold cost insights
while the saved quota comparison remains available. API equivalents and output token
counts do not measure task quality or productivity.

Zooming requests finer cost intervals from recorded transcripts. The curve spreads
each confirmed percentage drop across API spending since the previous drop. Repeated
whole-percent readings do not pin the fractional curve. Dotted horizontal guides
use exact whole percentages when zoomed, with markers at estimated crossings.
Original readings remain available in the saved-readings inspector. After the last drop, the unfinished fraction uses the previous drop's cost
provisionally and stays within one percentage point of the last reading. API-derived
decimals are estimates, not additional account measurements. Partial-bin totals are
prorated; missing or unpriced costs keep the straight-line connection.
Different models can consume quota differently, so API activity is a guide to
where to investigate, not an exact account of subscription allowance.

**Model comparisons at API prices** applies the same estimated API-price equivalent
of the remaining quota to GPT-6 Astra, GPT-6 Sol, GPT-5.6 Terra, and GPT-6 Luna.
Its default input/cache/output mix comes from the exact monitored interval.
The model breakdown below it uses that same
interval, excludes Spark, and counts reasoning inside output once. Older servers
without model totals show a pending state; example mixes remain available.

Choose an example mix, output only, or uncached input only to explore other work.
**Custom mix** lets you set the output share and the cache hit rate for input.
Cache writes use each model's published write price. Long-context and Fast mode
controls apply their respective token-price multipliers.
Each row applies the whole estimate to one model, so rows cannot be added together. M means
million and B means billion. Prices have a verification date and a source link.
Tool charges and regional surcharges are excluded. These are API-price comparisons;
changing models can change Codex consumption, so they do not guarantee a number of
Codex tokens. Incomplete cost data withholds the comparison.

Luna starts with dated public search results and retains useful indexed posts when
X blocks direct access. Indexed discussion is labeled partial and cannot confirm
a firsthand reset. Third-party probabilities and banked-credit announcements cannot
supply a broad-reset time window.

On your configured birthday, the celebration keeps your selected T3 theme. Make a
wish to put out the candle, run it again to relight it, or open **birthday.log** for
another note. Confetti is brief and respects the tap-effects and reduced-motion settings.

**Used while monitored** prices Codex transcripts from the same observed interval.
**Remaining quota at API prices** uses that cost per observed percentage point. It shows **Learning**
until at least five points have been observed. A qualified earlier reset cycle can calibrate a
shorter interval provisionally until current measured costs are ready. Bounded zero-use timer
changes totaling up to 60 minutes can bridge the interval without counting as resets. Spark is
excluded because it has a separate quota.

Dollar values are API-equivalent estimates, not subscription bills, cash balances, or credits.
Model mix and missing history affect them. Incomplete scans and missing prices withhold a new
current estimate while a refresh is pending; previously saved exact costs remain labeled with
their calculation time. A qualified earlier reset cycle can provide a labeled provisional model
and value estimate until current costs are ready. Within the same cycle, the last complete cost
remains visible through its recorded date while the scan warms, using that saved percentage
denominator until a newer complete reading replaces it.

The monitor defaults to the quota-source computer. Use **Tracking and computers** to opt in to
other computers for cost comparison. Selecting an unavailable computer withholds the combined
estimate. Select computers using the same Codex account. Percentages are never added across machines.
The tracker does not verify account identity or identify chats copied between distinct sources.
The power monitor is separate and does not contribute to Codex quota totals.

The reset-cycle arrows update the chart, API-equivalent value, and token planner together. Older cycles are calculated from their recorded transcript interval. Local Qwen sessions do not count toward the OpenAI subscription conversion. Refresh keeps the selected cycle. Incomplete transcript reads retry automatically with a bounded backoff; complete saved calculations remain available while newer data is being read.
