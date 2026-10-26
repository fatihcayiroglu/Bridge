# D2 thread admission after PostgreSQL waits

The 086 BEFORE trigger checks channel availability before inserting a thread or
reply. A later unique-index wait can outlive the policy it admitted. On the
092 baseline, competing inserts into `threads` and `thread_messages` both
committed after the channel was expired during that wait, at READ COMMITTED,
REPEATABLE READ and SERIALIZABLE. Six real PostgreSQL negative controls failed.

Migration **095** attaches the existing 092 final-admission function to both
tables as ordinary AFTER INSERT/UPDATE triggers. It reuses the database clock,
tenant and tombstone checks, ordered channel locks, erasure exception and
snapshot-isolation handling. There is no second expiry implementation.
Numbers 093 and 094 remain reserved for #379 reporting and #381 erasure indexes;
095 requires 092's function and no columns from either reserved migration.

## Recovery and data safety

The migration changes triggers only. Existing conversations, retained moderation
evidence, tombstones and pending object releases are untouched. Its down script
removes only its two triggers, preserving 092's message guard and shared function.
Rollback weakens enforcement after waits; prefer roll-forward. Reverse 095 before
092. An isolated reversal of 092 must refuse to drop its still-referenced function;
do not add CASCADE or remove dependants behind the migration runner's back.

The 092 executable recovery test now unwinds 095 first. Separate real PostgreSQL
tests verify 095 down/up/replay restores the same trigger definitions and leaves
seeded threads, replies and the message guard unchanged. The corrupt legacy rows
used by two read-authorization suites are still seeded under an ACCESS EXCLUSIVE
transaction, with both guards re-enabled before any reader is exercised.

## Measured evidence

Local PostgreSQL 18:

- Baseline: six race tests fail; all six writes commit after the policy changes.
- Correction: twelve race cases cover both tables and all three isolation levels,
  including successful writes under the same waits when the channel remains live.
  Every writer uses `SET CONSTRAINTS ALL DEFERRED`; it cannot defer the final guard.
- The final suite includes trigger/data recovery: **416 tests / 61 suites pass,
  zero skipped**, using real PostgreSQL, Redis and an S3-compatible RustFS service.
- Existing write-denial mapping unit tests: **5 pass**, zero skipped.
- Strict test types and production indexed-access/catch gates pass with zero debt.
- Fresh 095 boot and upgrade from 092 produce identical complete public-schema
  `pg_dump --schema-only --no-owner --no-privileges` output after removing only
  pg_dump's randomized `\restrict` / `\unrestrict` keys. Both normalized dumps
  are 141,868 bytes, SHA-256
  `ad4ae441af78bd0acf33c1e00433c7c63ea45ad7e4ac7b83375750168f402d0f`.

The real PostgreSQL rollback gate first rejected the newly introduced isolated
092 dependency, while 095 was lossless and the full ordered chain had zero lost
or extra schema objects. The manifest explicitly classifies that measured 092
dependency; no rollback SQL or gate assertions are weakened. With that declaration,
the complete real PostgreSQL gate passes: 73 lossless, 16 expected dependencies,
one expected irreversible and three shared-object classifications, zero actual
failures. The ordered chain has zero missing or extra schema objects. The release
integrity suite passes 38 tests, zero skipped. Exact-head CI remains a release gate. These
synthetic local databases do not certify legacy v1.122.0 migration, production
performance, physical devices or complete P7 acceptance. Keep #321 open. Do not
merge #375 into production main without separate owner authorization.
