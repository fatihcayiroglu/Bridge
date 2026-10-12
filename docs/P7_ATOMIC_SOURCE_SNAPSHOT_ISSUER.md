# P7 C4 — transactional source-side paired snapshot issuer (offline only)

**Status: unmounted internal function and regressions.** No HTTP export endpoint
or import/apply route is enabled by this change. Owner auth and step-up routing
are **not implemented** for the new issuer. Do not call it with identity, signing
key or source origin taken from untrusted client input.

The function `issueAtomicPortableSourceAttestation` in
`server/lib/portableSourceSnapshotIssuer.ts` accepts an independently
provisioned Ed25519 private key, HTTPS source origin, owner identity and a
PostgreSQL pool. It checks the owner **inside** one read-only `REPEATABLE READ`
transaction and queries server, categories, channels, roles, canonical channel
permissions and counts of legacy overrides from **the same connection**.

- The transaction begins before the first table read. No repository helpers
  can silently borrow a second pool session.
- Source reads have explicit row bounds (500 categories, 500 channels, 2000
  roles, 20,000 overrides per class); 512 KiB manifest caps remain active.
- No user identifiers or legacy target identifiers are selected; canonical
  user-target or foreign grant rows fail closed instead of being translated.
- Both C2 manifest builders receive **one** export timestamp, and their
  canonical digests undergo the C3 pair validator before transaction commit.
- Failed reads, foreign IDs, owner mismatches, bad bigint conversions or
  excessive source rows result in `ROLLBACK`, a generic error and no issued
  proof.
- On successful `COMMIT`, an Ed25519 proof signs both exact validated
  digests, source identity, origin, random snapshot ID, short expiry and SPKI
  key fingerprint. The existing destination offline verifier checks the result.
- The response retains `importSupported: false`,
  `writesPerformed: false`, `mappingApproved: false` and
  `remotelyVerifiedAtomicity: false`. The source reports a single-connection
  snapshot read; the verifier cannot independently attest that the remote
  operator ran the intended transaction.

## Why this is still NOT a complete export/authenticity protocol

The source origin/key currently arrive from a trusted server-side caller,
not a durable key registry. Key generation, secure storage, bootstrap,
revocation, rotation, source signature issuance HTTP routing, source snapshot
replay ledger and independent-instance trust provisioning remain unimplemented.
There is also no destination approval, permission elevation policy for applies,
serializable write transaction or rollback of destination objects.

A public route will require **authenticated current source owner**, fresh
`account.export` step-up, a source-side deployed signing identity (never a
client-provided PEM), an out-of-band destination pin, and explicit replay policy.
Do not connect this function to a route before those controls and their tests
exist. Never log or distribute private key material.

This incremental feature tracks [issue #205](https://github.com/fatihcayiroglu/Bridge/issues/205).
The unit suite asserts transaction sequencing and fail-closed bounds. The
**real** PostgreSQL test
`server/tests/pg-integration/p7-source-atomic-snapshot.pgtest.ts`, executed by
CI's mandatory `test:pg` step with `PG_TEST_URL`, performs actual concurrent
COMMITs from another connection after the read snapshot was established, then
checks that the signed pair reflects the same older MVCC state. This is live
single-database evidence, **not** a two-independent-installation deployment
proof, an out-of-band key trust bootstrap, or physical-device validation.
