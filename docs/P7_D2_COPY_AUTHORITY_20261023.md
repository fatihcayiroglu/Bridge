# D2 source copies and final write admission — 2026-10-23

## Reproduced boundaries

Real PostgreSQL tests reproduced deferred bridge forwarding from an expired
source into a permanent destination, direct copied INSERTs carrying that stale
source, and publication of a detached copy after its source expired. The live
bridge control passed. Protecting the destination alone did not protect the
source's content.

A separate interleaving held an upload-reference reservation while a normal
message INSERT waited in migration 091's BEFORE trigger. Migration 086's earlier
expiry check had already passed; expiry during the wait did not stop the INSERT.
The regression observed an actual committed row instead of the required BX001.

The expanded suite also demonstrated a repeatable-read bypass: KEY SHARE allowed
an old snapshot to keep using pre-expiry metadata after a non-key expiry UPDATE.
The assertion required a serialization failure and failed before the stronger
lock was added. These findings are not classified as flakes.

## Implementation

Migration **092**, following the unchanged 085–091 sequence, adds an ordinary
AFTER ROW guard on message INSERT/UPDATE. It runs after BEFORE triggers and
index/reference waits, inside the writing statement. It reuses 086's existing
`bridge_channel_assert_writable` and narrow erasure classifier; there is no new
timestamp or tombstone policy. An ordinary trigger cannot be deferred by
`SET CONSTRAINTS`.

The final guard locks the destination, any changed old destination, and a new
copy source in sorted order. READ COMMITTED retains KEY SHARE, allowing ordinary
metadata updates while its volatile policy reads fresh state after waits. At
repeatable-read/serializable isolation, FOR SHARE forces stale writers to fail
instead of reading an old expiry value. Only those stronger-isolation writes
can hold ordinary metadata updates until their transaction ends. This distinction
preserves the existing non-contention regression and worker coordination; using
SHARE unconditionally failed that regression and blocked a worker test, so it
was corrected rather than relaxing either assertion. Both source and destination
are checked after the locks are held. Missing, malformed,
tombstoned or cross-tenant copy sources fail closed.

Existing authorized copies keep their destination's lifecycle. Ordinary edits
do not reread historical provenance. The existing erasure exception remains:
an account-erasure or permitted soft-delete operation can scrub an expired row.
The migration rewrites no existing conversations, reports or evidence. Its down
script removes only its trigger/function, preserving all data and leaving 086
in place. Rolling it back removes the additional enforcement; a deployment
must pause dependent writes or roll forward. It is not an evidence/outbox purge.

The shared publisher now checks both channels through the existing authoritative
batch read guard. The legacy announcement socket path uses the same publication
decision after its idempotent transaction. A denied post-commit broadcast never
re-sends detached content. No client timestamp or cleanup-worker timing grants
access.

## Verification and limits

The PostgreSQL suite exercises the real send handler, direct INSERT/UPDATE,
crosspost transaction rollback without an orphan idempotency log, source-worker
lock interleaving, upload-reference waits, repeatable-read snapshots, tenant and
tombstone denials, permanent-copy compatibility, erasure, and SET CONSTRAINTS.
An additional migration test compares actual function/trigger definitions,
enabled/deferrability flags and existing data through down/up and replay. The
general rollback gate's catalog covers columns, indexes and constraints; it is
not sufficient alone to prove this function/trigger migration.

The complete 92-migration ordered gate has no actual failures or new rollback
classifications. Focused unit tests exercise source/destination publication and
the legacy announcement handoff. Full suite, fresh/upgrade catalog and final
commit CI results belong on the review PR. The read-only
`server/scripts/verify-schema-equivalence.cjs` compares independent databases
using mandatory `PG_UPGRADE_URL` and `PG_FRESH_URL`, including full function and
trigger definitions, RLS settings and grants; it rejects comparing a database
to itself. It prints catalog counts/hashes, never URLs or application rows.
Native iOS lifecycle, representative
deployment performance, human review and final integration checks remain
separate requirements. Issue #321 and broader P7 acceptance remain open.

Local final verification used PostgreSQL 18.6, real Redis and S3-compatible
storage: 368/368 integration tests (58 suites) and 13,153/13,153 backend tests
with coverage (710 suites), zero skips. Strict production/test types and server
lint pass without adding debt or lowering thresholds. The final 92-migration
ordered rollback gate has zero problems and no changed classifications.

An actual empty-database bootstrap through all 92 migrations was compared with
the populated 091 database upgraded to 092. All 862 columns, 872 constraints,
279 indexes, 47 full function definitions, 21 trigger definitions/settings and
88 table access settings matched, along with policy catalogs. The shipped
read-only comparator rejected a same-database comparison, an unavailable
connection and a disabled final-admission trigger; re-enabling that trigger
restored an exact match. CI on the final commit must still pass.
