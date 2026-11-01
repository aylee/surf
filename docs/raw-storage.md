# Raw evidence storage

Forecasts, source freshness, observations, issued numeric history, and Analysis
read D1. No API or extractor job reads archived R2 objects at runtime. Raw
bodies exist for parser incident diagnosis and optional offline evaluation;
they are neither camera video nor session replay. Builds and worktrees do not
upload their files. An explicit remote ingest does fetch another provider cycle.

## Diagnostic policy

The v2 writer captures scheduled generations at UTC hours 00, 06, 12, and 18.
Forecast ingestion and publication remain hourly. Sampling uses the logical
generation time, so delayed Queue delivery cannot change the decision. Manual
ingestion captures evidence deliberately. At other hours source metadata and
normalized values still persist, without duplicating raw bodies.

Each provider/source batch captures at most 2 MiB across 40 successful GET
responses. CDIP retains its tighter 64 KiB per-response cap. Slow capture stops
after five seconds; a failed/oversized capture leaves the original provider
response available to the adapter and reports the evidence gap. The cap is
shared across concurrent responses. Archive failure never invalidates otherwise
usable normalized forecasts or multiplies accepted materialization children.

Bodies are gzip compressed and stored at
`raw/v2/{source}/{YYYY}/{MM}/{DD}/{full-content-identity}.{format}.gz`.
The identity includes MIME and the complete SHA-256 of the uncompressed body.
Create-only conditional puts reuse existing bytes without overwriting evidence
or extending its object age. Daily partitions permit expiry without a global
reference-counting collector. Shared objects carry content metadata; each D1
capture retains its own run, request URL, capture timestamp, raw byte count,
compressed byte count, encoding, and raw checksum. Multiple rows in the new `raw_artifact_captures` table can point to one object
after additive migration 0006; the legacy `source_artifacts` table stays intact. D1 stores the per-run v2
manifest; R2 no longer receives a redundant manifest object.

Thirty days of diagnostic evidence are retained. Manifests explicitly state
`availableUntil` at generation-date midnight plus 30 days. This is a conservative
availability boundary, not a promise that expired bodies are still present.
V2 captures and per-run manifests separately state `metadataExpiresAt`, 35 days
after actual persistence time. D1 removes those references only after that
later boundary, preserving five days beyond normal upload-age expiry for
lifecycle processing and incident investigation. Delayed persistence does not
shorten the buffer by using an old generation date.

Known legacy `source_artifacts` rows keep the same 35-day metadata buffer from
actual row creation. Legacy per-run archival pointers/manifests use the later
of actual completion and embedded manifest creation, also plus 35 days.
Only valid UTC timestamps are used; if neither actual timestamp is valid, keep
the pointer for inspection rather than guessing its age. Only the five known provider prefixes listed below receive this shorter raw
metadata policy. Unknown prefixes retain their prior 400-day policy. Source-run
rows, normalized numeric history, and the shared 400-day history constant are
not deleted or shortened by these raw-only rules.

The buffer protects expected lifecycle lag; it is not an atomic proof that R2
has deleted an object. If lifecycle is blocked for more than five days, bodies
can outlive their metadata. Inspect expiry state and inventory on that error.
Archived bytes cannot recreate an uncaptured intermediate hour. Offline
evaluation needing a longer raw record must explicitly export the chosen
evidence before expiry; this is not a continuous raw-training archive.

## Physical expiry is a separate operator action

No code path, setup command, or release command installs R2 deletion rules.
Apply only an explicitly authorized bucket/prefix/horizon policy. The policy
in `docs/raw-storage-lifecycle.proposed.json` expires the following five provider
prefixes after 2592000 seconds (30 days), in both their legacy `raw/` layout
and their new `raw/v2/` layout:

- `cdip-mop-forecast/`
- `coops-tide-predictions/`
- `ndbc-realtime2-standard-meteorological/`
- `nws-mtr-grid-wave/`
- `nws-point-forecast-alerts/`

These ten precise expiry prefixes cover retained legacy evidence as it ages;
no catch-all `raw/` or `raw/v2/` deletion rule is used. Unknown non-provider
prefixes are preserved. Preserve the existing multipart-abort rule (seven
days) and every unrelated rule when reconciling the live policy. The JSON is
an API-shaped policy artifact, not an automatic mutation.

[Cloudflare lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
states that expiry applies to existing matching objects too, removal usually
occurs within 24 hours, and deletion timing can take longer. A D1 SQL export or
Time Travel bookmark does not back up R2 bytes. Removing a rule stops future
expiry; it cannot restore deleted bodies. Keep Standard storage.

## Inventory and cleanup

Use the existing complete metadata scan when one is available. Otherwise:

```bash
pnpm storage:audit --bucket YOUR_BUCKET --prefix raw/ \
  --before 2026-10-02T00:00:00Z --output /tmp/raw-inventory.jsonl
```

Choose the cutoff explicitly. The audit only lists object metadata; it never
downloads bodies or mutates resources. It writes private inventory and summary
files, hashes the exact inventory, refuses overwrites, and marks failures or the
page budget incomplete. `cf` currently emits an array without pagination state,
so the audit continues by strict `start-after` until an empty page, even when a
page is short. It rejects repeated/unordered keys and invalid metadata.
An inventory pass is not an atomic snapshot. Before approved deletion, recheck
each selected key's current ETag, size, and modification time; skip changed
objects and stop on uncertainty. Confirm the current live binding and all known
writers before retiring any old bucket.

Delete candidates must name the exact bucket, raw prefixes, cutoff, object
count, bytes, age bounds, manifest checksum, dependencies, and feature impact.
For an explicitly approved historical cleanup, remove exact confirmed R2 keys
first, then clear only their matching `source_artifacts` rows and
`source_runs` archival pointers from verified deletion receipts. Never delete
source runs referenced by normalized forecasts. This one-time exact-key cleanup
is separate from ongoing 35-day metadata expiry. A pending cleanup must not be
represented as completed.

## Budget and observability

`raw_artifact_capture` logs the capture decision, bytes, artifacts, and gaps for
every source batch. `raw_artifact_storage` logs raw bytes, newly stored compressed
bytes, reused objects, source/run identity, logical availability, metadata expiry, and errors. Sum `storedBytes`
to measure growth; it excludes reused bodies. Use metadata inventory totals for
actual physical storage; sum raw D1 bytes only to measure logical evidence.

The nominal 11-spot topology has three source batches and five providers:
4 captures/day × 3 batches × 5 providers × 2 MiB = **120 MiB/day** before
compression and sharing. Thirty days plus a typical one-day lifecycle delay
models roughly 3,720 MiB at nominal cadence, plus gzip overhead and metadata.
This is a capacity envelope, not a hard bucket cap: up to three Queue retries,
changed responses on retries, repeated manual ingests, and delayed deletion can
increase it. Compression/sharing should materially reduce measured storage;
do not promise a particular ratio without measurement.

Target under 1 GiB once the retained pre-refactor evidence has aged out;
investigate at 2 GiB or more than 50 MiB/day of new compressed bytes. At 8 GiB
of account-wide R2 storage, inspect lifecycle, other buckets, manual-ingest rate,
retries, and capture-error counts before expanding capture. These are operator
thresholds, not installed alerts or hard quotas. A deployment can stop new
capture by passing through the base fetcher while leaving hourly forecasts on;
do not disable the forecast scheduler to solve raw-storage growth.

## Rollback

Before deployment use the supported production release preview with a fresh D1
bookmark/export and the exact predecessor Worker version. Migration 0006 only
adds the v2 capture table and indexes; old Worker code can still write its
run-specific keys. Leave this additive table in place when rolling back. For
an extended rollback, explicitly maintain v2 metadata expiry so its foreign
keys do not outlive the original 400-day source-run retention job. The legacy
table and source-run lineage remain structurally intact; only authorized raw
metadata retention changes. Reverting the writer does not reverse physical
expiry or historical cleanup that has already run, and
must not resume unbounded legacy writes without a time-bounded incident plan.
