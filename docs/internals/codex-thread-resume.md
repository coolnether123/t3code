# Codex thread resume

Reopening a provider session calls `thread/resume` with `excludeTurns: true`.
The existing provider thread ID stays unchanged. T3 already owns its display
history, so session startup does not need Codex to return the archive again.
The generated request schema must retain this field during encoding.
`packages/effect-codex-app-server/scripts/generate.ts` supplies the compatibility
field until the next full upstream protocol refresh.

## Large histories

A legacy full-history response can exceed Node's maximum string length even
when the daemon resumes the thread successfully. A synthetic 1,342,780,333-byte
rollout produced a 671,373,075-byte reply. The Node consumer failed with
`RangeError: Invalid string length`. Metadata-only resume returned 1,925 bytes
for the same thread. Codex 0.159.0 and 0.160.0 accept the option.

Codex 0.160.0 also supports paginated native history and `migrate-rollouts`.
Its app uses tail hydration and paginated history. Migration changes the
JSONL representation, so preserve and verify an original archive before a
real cutover. Do not enable broad background migration as a resume workaround.
Already-paginated threads need no migration.

## Verification boundary

Account-free loopback-provider checks exercised 2,147,692,603-byte synthetic
rollouts on Elora and Millie. They resumed the same IDs, completed new turns,
and returned every original user message and image through 205 bounded pages.
Native app UI acceptance and the coordinated T3 release are separate checks.
