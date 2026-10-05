# Usage metadata observations

`server.getUsageReport` accepts `mode: "observations"`. This report reads bounded
metadata separately from native transcript totals. It does not fetch pricing,
scan ordinary provider transcripts or change their cache. It has no `totals` or
`calculation` field.

The report preserves nullable counters, recorded counts and reported charges.
ACP cumulative session charges carry `scope: "session"`; they are not request
charges. Router output lacks measurement provenance and remains a recorded count.
An Otis decision with a native job ID has `disposition: "correlationOnly"`. Join
only the exact ID to a router job and never add both rows together. These rows
do not allocate costs across tasks or verify provider account coverage.

## Configure sources

The host environment supplies `T3_USAGE_OBSERVATION_SOURCES` as a JSON array.
Queries accept only a real day window, time zone and output limit. They cannot
select paths, URLs or actors. Keep private paths in host configuration, not
source control or task text. Configuration does not authorize a new private
import, account connection, paid request or credential change.

Each source has one stable `sourceId`. Use the same source identity for an active
file and its archived copies. Duplicate source identities fail configuration
validation. Supported shapes are:

```json
[
  {
    "kind": "router",
    "sourceId": "router-local",
    "files": ["C:/synthetic-fixture/router.jsonl"],
    "additiveSources": ["otis-decisions"]
  },
  {
    "kind": "acp",
    "sourceId": "cursor-local",
    "provider": "cursor",
    "files": ["C:/synthetic-fixture/cursor-native.log"]
  },
  {
    "kind": "decisions",
    "sourceId": "otis-local",
    "baseUrl": "http://127.0.0.1:5197/",
    "actorId": "user:local"
  }
]
```

These are synthetic paths and an example local endpoint, not a live setup.
`provider` for ACP is `cursor` or `grok`. Router native Codex/OpenCode traffic and
remote cloud passthrough are excluded regardless of `additiveSources`. Router
and ACP reads reject linked paths. Decision reads allow only a literal loopback
HTTP origin and never follow redirects. The host supplies its existing permitted
actor identity; the query cannot change it.

## Interpret coverage

Absent configuration reports `missing`. Reads preserve good rows when another
source fails, but report `partial`. Missing counters stay null. Complete malformed
lines, conflicting identities and duplicate copies have separate counts.
Conflicting receipts for one exact request are removed even if a later copy
matches an earlier one. Unknown dates cannot satisfy a day-window read.

Limits are 16 sources, 32 files per source, 32 MiB per read, 100,000 lines,
128 KiB per ACP line, 10,000 retained rows, eight 100-row decision pages and
512 output rows. Decision responses have a 512 KiB page cap and share a
ten-second abort signal with ACP reads. Source changes, incomplete tails,
budget limits and output truncation remain explicit. A bounded observation
report is not a complete bill or a complete provider history.

Native row pricing remains in the ordinary usage reports. This view adds no
new rates, scheduled work, credentials or live source selection.
