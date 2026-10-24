# D2 lifecycle admission for portable source exports

The source attestation issuer read channel metadata directly, bypassing the
channel lifecycle guard. A real PostgreSQL probe against the complete application
schema returned expired and tombstoned channel names/topics with a valid source
signature; its permanent-only control succeeded. A green general CI run therefore
did not establish this acceptance criterion.

## Correction

The bounded source graph still comes from one REPEATABLE READ READ ONLY snapshot
on one physical PostgreSQL session. The existing canonical batch lifecycle policy
filters channels before either manifest is built. Canonical grant rows are still
checked against the complete source channel identity set and expected tenant, so
foreign or orphan channel grants cannot disappear through that projection.
The existing static-v1 resource caps remain; this endpoint is not paginated.

After committing the graph snapshot, a second READ COMMITTED READ ONLY transaction
on the **same session** checks every included channel again. A repeatable-read
snapshot alone cannot see a concurrently committed expiry policy or tombstone.
Unavailable or unverifiable channels refuse the entire stale export at this
boundary; no partial signed result is returned.

The canonical batch reader now also exposes conservative monotonic deadlines.
Each deadline starts before the query dispatch and adds the remaining lifetime
from PostgreSQL's clock, thereby charging query/network time against it. The
existing Set API wraps the same policy; no second expiry classifier is added.
The issuer checks these deadlines after the final COMMIT and again before return,
including signing and self-verification time. Its existing five-minute attestation
window also bounds total processing time, independently of a frozen wall clock.

An uncertain COMMIT in either phase discards the pooled session. Known read or
policy failures roll back the active read-only phase and return the existing
opaque error. Permanent and active channels remain exportable. No migration,
content cleanup, retained evidence deletion, object release or permission change
is introduced. The graph's `sourceReadIsolation` still describes its one original
snapshot; the additional transaction only admits its lifecycle for publication.

## Evidence

- Original issuer: one positive MVCC control passes; four added PostgreSQL
  regressions fail, zero skipped.
- An intermediate fresh-check-only implementation still failed the real delayed
  COMMIT case: the channel was active at its final read and expired while the
  reply was held for 2.2 seconds. The monotonic deadline closes that gap.
- Corrected focused PostgreSQL: **5 pass**, zero skipped, including the unchanged
  concurrent graph snapshot control, permanent/active controls, unavailable
  metadata and grants, concurrent expiry/tombstone commits and delayed COMMIT.
- The probe against the complete public schema now returns only the permanent
  control with a valid signature and no unavailable channel metadata.
- Full real PostgreSQL/Redis/S3-compatible suite: **430 tests / 62 suites pass,
  zero skipped**. S3-compatible service: RustFS; no local pgvector claim.
- Focused unit/route/canonical-guard suites: **53 pass**, zero skipped. Strict test
  types and indexed-access/catch gates pass with zero debt.

Exact-head CI, required reviews and the previously recorded Android failures
remain separate gates. This source-side correction does not close the remaining
target import/write-path audit, replace the C4 owner-proof deadline work, certify
legacy upgrades, or establish complete D2/P7 acceptance. Keep #321 open. Do not
merge #375 or an indirect equivalent into production main without separate owner
authorization.
