# Portable mapping must respect destination-channel lifetime

The existing default-off, explicitly opted-in metadata-only mapping path included
expired destination channels in its locked review. An approved mapping could also
wait across expiry and then update the expired row. This correction reuses
`channelReadExpiryGuard` rather than introducing a second expiry policy.

The review first validates the complete bounded stored topology, including tenant
and identifier invariants, then excludes expired/tombstoned destinations from its
fingerprint. An unrelated unavailable channel does not prevent a valid permanent
channel mapping. Included channels must still be live after subsequent grant reads
and delayed database responses, using the guard's monotonic lifetime windows.

Atomic application upgrades mapped channel locks in identifier order, verifies
membership in the target tenant, and rechecks authoritative lifetime after lock
acquisition. It checks again after metadata, grant, replay and audit writes,
immediately before COMMIT. Expiry at either check rolls back the complete graph,
approval consumption, replay marker and audit insertion. Existing uncertain-COMMIT
handling is preserved. The change adds no schema migration, expiry mutation,
permission bypass, object deletion or identity transfer.

## Executed local evidence

- Restoring only the two production modules to parent `14b21524` while retaining
  the real PostgreSQL regressions: **9 PASS / 10 FAIL / 0 skipped**. Corrected
  sources were restored before validation; the failures demonstrate the original
  target-lifecycle defect.
- Focused corrected suites: **32 unit tests** and **21 real PostgreSQL tests**
  pass, zero skipped. Coverage includes live/permanent controls, expired and
  tombstoned targets, shared channel-lock waits, later grant/audit-lock waits,
  delayed real database responses, and atomic rollback/reusable approval.
- Full server Jest coverage: **13,238 tests / 714 suites PASS**, zero skipped;
  statements 95.15%, branches 90.08%, functions 94.05%, lines 96.61%.
- Full real PostgreSQL/Redis/S3-compatible integration: **442 tests / 62 files
  PASS**, zero skipped. Local object storage is RustFS, not MinIO; dedicated
  pgvector CI remains required. Production/test TypeScript and hardening gates
  pass without declared type debt.

Existing rollback tests previously set production mode even when requesting a
test-only failpoint, so they could reject before the intended SQL. The fixtures
now enable the failpoint only for that explicit test invocation, use the real
PostgreSQL client, trace every intended stage, and assert ROLLBACK with no COMMIT
and the unchanged complete graph/ledger. Active ephemeral fixtures use a positive
expiry version, as required by the canonical lifecycle contract.

This unit does not accept C4 or P7. Earlier C4 security branches (#387–#394) still
require deliberate integration and exact-head revalidation; this branch must not
replace those independent source, deadline, trust, TLS or uncertain-COMMIT fixes.
Full portability, production trust enrollment, platform acceptance, review and
owner-approved promotion remain outside this bounded correction. Keep #321 and
P7 open. No direct or indirect #375-to-production-main merge is authorized.

## October 25 integration refresh

The correction is now based on #420 (`95444854565d8749a78f68c942a3088a7e5e6fac`),
including #417's existing deletion acknowledgement fix. The parallel alternate
client implementation was preserved locally and was not published or substituted.
The difference against #420 remains these eight server/test/documentation files.

On the combined server code (`40041f25`), **445/445 real PostgreSQL/Redis/S3
integration tests across 63 suites PASS, zero skipped**, on a new isolated
PostgreSQL database with the complete migration chain. The explicit no-skips
gate passes. Focused unit tests remain 32/32 PASS; strict production/test and
hardening types pass. The earlier full 13,238-test coverage run is on this
server correction before adding #420; exact-head CI must verify the combination.

Setup failures are retained, not treated as passing tests: an initial local
command omitted test-service selectors and was interrupted; its abandoned
`pgt-d2-media-31399` fixture was still present in the old test database. A second
run also explicitly set `REDIS_URL` without the application's Redis bootstrap,
correctly triggering fail-closed authorization/coordination, and failed
378 PASS / 67 FAIL / 0 skipped. The old database and both logs are preserved.
The corrected command matches CI: `REDIS_TEST_URL` for real Redis test clients,
`MINIO_TEST_ENDPOINT` for real S3, and no global `REDIS_URL` that would incorrectly
configure partial application fixtures as initialized cluster nodes. The new
database prevents the interrupted fixture contaminating subsequent worker tests.
No production check, failed assertion or Redis failure behavior was weakened.
