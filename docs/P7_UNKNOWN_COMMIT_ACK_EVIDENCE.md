# P7 C4 — lost PostgreSQL COMMIT acknowledgement (deterministic evidence)

**Scope:** A narrow, real-PostgreSQL integration test for an ambiguous
`COMMIT` response in the existing-mapped-metadata apply path. This is NOT
independent TLS deployment acceptance, real process-crash injection, or full
community import.

## What this test proves

- Snapshot #1 has already been committed using the normal path.
- A distinct Ed25519-signed source snapshot (#2) changes an already-mapped
  destination category label. Its review fingerprint, live destination
  topology and one-use owner approval are freshly verified.
- The integration test sends an actual `COMMIT` to PostgreSQL, allows the
  database to finish it, then deliberately throws **only while returning the
  COMMIT acknowledgement** to the importer.
- Because the acknowledgement is missing, the importer must return a
  generic **failure** and must never claim `transactionCommitted: true`
  to the caller. Once `COMMIT` has been attempted, the importer does **not**
  run a compensating `ROLLBACK` on the uncertain session and releases the
  physical PostgreSQL client with an error, forcing the pool to discard it.
  A `ROLLBACK` cannot undo a successfully committed transaction.
- An independently acquired PostgreSQL pool/connection confirms that the
  changed category, consumed approval, signed snapshot reservation and one
  redacted audit event **did commit together**.
- The failure-injection test also asserts that the unknown-COMMIT session
  was discarded and was never reused with a misleadingly clean release.
- Retrying the original token refuses. A direct duplicate signed-snapshot
  insertion from the new connection is rejected by the PostgreSQL UNIQUE
  barrier. Repeated requests do not create an additional audit event.

**Operational consequence:** a timeout/transport error near `COMMIT`
is **not evidence of rollback**. Clients must use a new authenticated
read/re-export to determine current destination state, never blindly
resubmit the original approval or automatically mint a new one.

## Same session-disposal invariant across P7

The identical generic, no-success, no-compensating-rollback and error-marked
pool release rule also applies to:
- `stageOwnerConfirmedPortableApproval` (owner-signed review staging):
  do not reveal a one-use capability when COMMIT is ambiguous.
- `stagePortableImportApproval` (older internal staging primitive):
  never return the token on uncertain persistence.
- `issueAtomicPortableSourceAttestation` (read-only paired source export):
  never issue a signed source artifact or return a possibly poisoned session
  if the snapshot's read-only COMMIT acknowledgement is lost.

Unit regressions assert each path discards the exact uncertain physical
client; normal validation failures still use rollback. None of these checks
is a substitute for testing real broken TCP sockets or a database restart.

## Limitations / next acceptance work

This test intentionally replaces only the application's receipt of a
successful PostgreSQL COMMIT acknowledgement. It does not simulate a
terminated TCP socket, database crash/restart, loss of source availability,
or two separately deployed Bridge installations over TLS. Those remain
required for [P7 acceptance issue #205](https://github.com/fatihcayiroglu/Bridge/issues/205).

Run via the existing real PostgreSQL integration suite with `PG_TEST_URL`;
do not skip the test when PostgreSQL is unavailable and do not lower the
90% coverage requirement. The restricted mapped-apply API remains
double-opt-in and does not import users, role power or channel grants.
