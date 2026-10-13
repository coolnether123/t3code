# Import Codex sidebar sections once

Sections live in the server's `settings.json`, separate from conversation
events and projections. The additive `sidebarSections` setting is absent on
older servers. A new server advertises the `sidebarSections` capability.

For an authorized import, start the server with
`T3CODE_IMPORT_CODEX_SECTIONS_PATH` set to that computer's
`~/.codex/.codex-global-state.json`. The server reads the file only. It imports
only when `sidebarSections` is absent. Once saved, even deleting every section
does not reimport it on a later startup. Existing section metadata is never
overwritten by this route. Run without this environment variable for normal
installations that do not request an import.

The importer requires one unambiguous account with sections. It preserves
names, source order, collapsed state and supported color/icon appearance.
Only `codex:thread:local:<id>` references are candidates. Match exactly against
T3 thread IDs, Codex provider thread/session IDs and Codex resume cursor IDs
for non-deleted threads. Multiple T3 matches are ambiguous and stay out.
Duplicate membership follows source section order. No titles or chat text are
used for matching. No threads or projects are created or changed.

`sidebarSections.codexImport` records section, matched, unmatched, ambiguous
and duplicate counts. Startup logs contain those counts only. An unreadable
or invalid source leaves existing settings unchanged and logs a generic
warning. Confirm the saved counts and live sidebar before claiming import.

Use the guarded owner install route. Check all running turns, physical idle,
pending-request fingerprints and the exact live source before stopping. Keep
code rollback and original data. Verify an existing long thread through a
read-only client after deployment. Do not submit a test turn in a live account.
