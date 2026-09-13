# Repeated-input attribution

Repeated-input attribution is an additive projection on the regular Usage query. It does not
share state with the Codex reset monitor. Reset observations measure an account window. Repeated
input measures recurring payloads found in provider transcripts.

## Source model

The importer uses typed source kinds. Skills are the first source family, with `SKILL.md` files
such as `unslop` as an acceptance case. The extensible set also covers AGENTS or instruction
files, named reusable developer blocks, and repeatable tool-operation payloads. Arbitrary chat
text is not promoted to an operation just because its wording repeats.

Each aggregate item keeps a stable content fingerprint and, for file-backed sources, a file
revision or content hash. It also records display name, source kind, first and last observation,
occurrence count, affected session and turn counts, project or environment, model breakdown, and
confidence counts. The raw payload is never projected to a client.

Historical file revisions remain distinct items. An exact path can identify its revision; a
name-only reference that matches several revisions is retained as an attribution gap instead of
crediting every version.

Confidence is explicit. A transcript reference is weaker than a likely read. A likely read is
weaker than a confirmed complete payload read. The importer does not turn a file reference into a
full-read token count. The `unslop` evidence remains useful as a regression fixture because its
file size and tokenizer result can change without changing the attribution rules.

## Token and value accounting

Direct payload tokens are reported separately from the full input totals for the affected session
and turn. Direct values have exact, estimated, cached, cache-write, and unknown buckets. Cached
and cache-write values retain their provider meaning and are not silently folded into an uncached
bucket.

Provider-reported cost wins. Otherwise the projection uses the same model-pricing table and
revision used by the existing Usage page. Unknown models, absent prices, absent tokenizer support,
and incomplete token records remain unpriced. An unpriced value is not zero. Mixed rollups retain
the priced subtotal and label it incomplete instead of hiding known value or treating unknown input
as free. The UI calls all derived dollars **Estimated API-equivalent value**. That label means a
current-rate comparison, not a charge, subscription balance, or reset consumption.

## Incremental coverage

Transcript cache entries are keyed by the physical source and file identity. The saved cursor is
used only when the file prefix still matches. Unchanged files reuse their parsed records. A safe
append reads the new suffix. Rewrites, forks, retries, truncation, malformed records, and cursor
ambiguity invalidate or narrow the cache entry instead of adding a second copy of the same
occurrence. Repeated-input parser versions invalidate only their sanitized attribution metadata;
they do not throw away the ordinary Usage records already cached for the transcript.

The projection retains only aggregate counts, fingerprints, provenance, and coverage gaps. A gap
is visible when a transcript is too large, malformed, unavailable, lacks model identity, lacks a
matching tokenizer, or cannot be attributed to one payload. The importer does not guess through a
gap. Long-range queries return bounded aggregates so the clients do not render every transcript
record.

## Client boundary

The projection travels through the ordinary Usage request and is optional for older environments.
Web and desktop render the same subsection. Mobile renders a compact native subsection in the
normal Usage scroll. The reset page remains a separate destination and does not render repeated
input data.
