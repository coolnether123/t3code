# Scheduled Codex runs

The Scheduled shelf reads native Codex desktop automation history from the
configured shared Codex home. It is separate from T3's `projection_threads`.
Listing or viewing a run does not create a project, thread, event, or provider
binding. Other provider adapters do not expose this shelf.

`CodexDesktopStore` opens the newest `state_*.sqlite` read-only. The routine
query selects `thread_source = 'automation'`, uses the first title line after
`Automation:` as the group name, and falls back to `Scheduled automation` for
unrecognized titles. It includes `archived = 1`. A routine page has at most 50
groups; a history page has at most 25 runs. Previews stop at 240 characters.
The transcript endpoint checks the automation source again before using the
existing bounded `readThread` parser, which can read an archived run through
this endpoint. The ordinary Codex thread endpoint still excludes archives.
Missing state files yield an empty Scheduled list; malformed databases yield an
error. SQLite handles close after each short query.

The authenticated `/api/codex/scheduled` and `/api/codex/scheduled/runs` HTTP
routes use orchestration read scope. The run transcript route is
`/api/codex/scheduled/runs/:id`. Contracts live in `codexDesktop.ts`. Web and
desktop use the primary environment's HTTP layer, which handles same-origin
cookies and desktop bearer credentials. Mobile uses its environment HTTP auth
path so local, remote, and relay/DPoP connections sign requests correctly.
Neither client polls the native database: the web shelf fetches on opening, and
mobile fetches while the Scheduled screen is mounted.

The existing `AgentSessionImporter` imports recent sessions by project, not one
chosen automation run. Invoking it from a run would import unrelated sessions
and cannot guarantee an older archived run is included. Until a targeted import
path exists, transcripts are explicitly read-only.
