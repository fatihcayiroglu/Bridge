# D2 object-release recovery and reference races — 23 October 2026

Independent follow-up: draft [#364](https://github.com/fatihcayiroglu/Bridge/pull/364),
branch `p7/d2-acceptance-20261023`, targeting #362's integration branch.
Do not accept #362's object-release contract without integrating these fixes.

## Confirmed failures

1. A leased worker pauses, its deadline passes, and another worker claims the
   entry. The old completion could overwrite the new attempt's state, error
   and retry deadline. Real PostgreSQL reproduced late success, retained and
   failure completions; each corrupted the successor's state before the fix.
2. A batched reference scan finds no references. A live message then references
   the object. The batch used its old negative answer and deleted those bytes.
   The full object-release PG file reported 10 pass / 1 fail in this negative
   control, with no skipped cases.
3. `keyFromUrl` extracts a path without verifying its origin. A foreign URL
   containing `/uploads/server-assets/...` could select and delete a local
   file at that path. Three adversarial tests failed before the fix, including
   actual deletion of a temporary file. `locateAsset` now accepts exact relative
   references or the configured adapter's canonical service URL. Unverified
   legacy aliases are retained for operator reconciliation.

## Implementation

Every completion and retry checks its attempt number and unexpired database
deadline. Each object renews its lease before storage work. Superseded work is
counted separately. The lease duration and retry budget are unchanged. An
already-started storage request may outlive its lease, so deletes remain
idempotent; a late worker cannot acknowledge or reschedule a newer attempt.

Migration **091_upload_release_reservations** adds `upload_release_keys` and
reference-writer triggers. An UPSERT locks a key until the referencing write
commits. The releaser takes the same locks, runs one reference scan per batch
under READ COMMITTED, retains shared keys, and commits reservations for the
unreferenced keys. Only then does it call storage. New references to a reserved
key fail closed (`upload_release_reserved`), including on a stale
REPEATABLE READ snapshot. No storage request runs inside that transaction.

The trigger inventory matches the existing relational upload-reference scan,
including member profile JSON, podcast filenames, private attachments and
ownership metadata. Only recognized Bridge storage locations can be released;
an external URL cannot select a local object by basename. Missing database or
reference evidence causes durable retry, never deletion.

False writer-lock rows are pruned in bounded batches while skipping active
locks. True deletion reservations contain canonical storage keys only and must
outlive offline clients; they hold no conversation, owner, filename label or
absolute external URL. They remain after storage retries and deletion so an old
reference cannot recreate a deleted object identity.

## Upgrade and rollback

Migrations 085–090 retain their numbering and contents. Apply 091 before enabling
the corrected worker; the standard startup migration chain and readiness gate
enforce the schema prerequisite. The migration adds metadata and triggers and
rewrites no existing user content. Tests preserve an existing user row through
upgrade, empty rollback and roll-forward in an isolated schema.

Once a true reservation exists, 091 down **refuses** to discard it. Roll forward
or retain the reservation protocol; do not remove its rows to force a rollback.
089's pending-release rollback refusal remains intact. Older reversible columns
are not pinned by the new triggers. The full ordered 91-migration down/up proof
reports zero missing or extra schema objects and zero actual failures; no
rollback classification or assertion was relaxed.

## Validation and limits

- Object-release, reservation and asset-ownership units:
  **36 passed / 0 failed / 0 skipped**.
- Complete real PostgreSQL 18.6 + Redis + S3-compatible suite:
  **342 passed / 0 failed / 0 skipped**. The existing moderation visibility,
  retention, erasure, tenant and protected-storage regressions all execute.
- New PG cases cover in-flight writers, late references, stale repeatable-read
  snapshots, missing reference evidence, restart-safe reservations and rollback.
- Strict test types, hardening types and production build pass. SQL validation
  reports zero failures; its documented unsupported template/optional-vector
  classifications are not counted as executed SQL checks.
- The ordered migration gate and a 50,000-message local-disk benchmark run on
  disposable databases. Measurements are in [performance](P7_D2_PERFORMANCE.md).

An initial full PG run's shared-statistics assertion observed three extra scans;
their source was not established. The final 342-case run uses a fresh database
with SQL/migration verification isolated from it. Assertions and timeouts remain
unchanged; the earlier failure is retained in the work evidence.
Earlier CI on `c4feaf9d` was cancelled because the second confirmed race required
new code; those runs are not evidence for the final commit.

Exact final-commit CI and human review remain integration gates. This does not
close #321 or P7: the native iOS expiry journey, representative production S3
throughput and the other P7 pillar criteria remain separate requirements.
## Backup and restore of durable expiry state

The existing self-host process drill now seeds D2 recovery states in its own
disposable PostgreSQL installation before running the shipped backup/restore
scripts. The app is stopped during this fixture so worker progress cannot change
the expected snapshot. It covers a converged tombstone, open/resolved/dismissed
reports from a deleted private channel, pending and leased object-release rows,
a completed release, and reserved/unreserved upload keys.

`SH-BACKUP-D2-01` compares a digest of every column in those fixture rows before
backup and after restore, and requires the expected nonempty lifecycle states.
The retained `restricted` visibility policy is part of the comparison. Evidence
text, object URLs and user identifiers are not emitted in the report.

`SH-BACKUP-D2-02` executes the restored triggers: attaching an already released
key must fail with SQLSTATE 55000, and deleting the reported author must anonymize
all retained evidence snapshots. The erasure probe rolls back and the graph is
compared again before the existing API login/message/file checks continue.

Local PostgreSQL 18.6 validation used an actual `pg_dump` and the shipped atomic
`backup/restore.sh` into a separate disposable database. Both graph and security
trigger checks passed. Four negative controls independently removed a retained
report, tombstone, leased release entry or reserved key: each damaged graph was
rejected, and each intact graph passed after restoring the fixture row.

This is database recovery evidence, not production backup certification. A
production drill must also verify object-store backup/versioning, restore-point
consistency with external objects, deployment-specific lock/runtime limits and
the operator's recovery objectives. D3 and issue #321 remain open.
