# P7 C4 — durable one-use consent ledger (unmounted foundation)

**No approval HTTP endpoint, no destination apply endpoint, no data migration.**
This is a PostgreSQL primitive for the next steps of issue #205; installing
migration 081 does not enable import or issue user consent. This work does not
close #205 or claim production replay security until integrated and tested.

## Stored state

The `portable_import_approvals` table stores only a domain-separated
SHA-256 digest of a 256-bit random approval token. Each row binds:
destination community and OWNER; exact Ed25519 source origin, community,
snapshot and signing key; both signed manifest digests; destination topology
digest and the complete deterministic mapping review fingerprint. Expiry is
DB-clock-based, limited to 120 seconds and never beyond source attestation
expiry. No unsigned body, bearer secret, message content or user roster is
persisted.

The unmounted `stagePortableImportApproval` function starts its **own
SERIALIZABLE PostgreSQL transaction**, locks the destination server row and
checks current owner before storing a hashed token. Its inputs are trusted
only after a future owner consent route has independently verified the
attestation, fresh `account.import` step-up, unchanged target, safe mapping
and all permission grants. The helper itself does **not** verify these
prerequisites and therefore must not be exposed directly to HTTP.

The unmounted `claimPortableImportApproval` is a single conditional SQL
`UPDATE ... WHERE consumed_at IS NULL ... RETURNING`. The caller must run
it on the **same physical PostgreSQL client inside a SERIALIZABLE apply
transaction**, after fresh owner, source signature, target topology, grant
and mapping checks under appropriate locks, and before *every* mutation.
A committed claim is single-use, including after process restart. On rollback,
the claim and destination writes roll back together; the same valid token may
be tried again until expiry, but it must be fully revalidated before any
attempt. The future importer must decide whether stricter irreversible
failure burns are required and prove the policy with live DB failpoints.

This ledger does not by itself ensure that the owner explicitly consented,
that the source signature is still trusted, that the destination is unchanged
or that permission scope is safe. Neither `reviewFingerprint` nor a
random token is sufficient authorization. All these checks remain mandatory
within the final apply transaction.

## Operational/test contract

- Run versioned migration `081_portable_import_approval_ledger.sql`;
  rolling it back destroys all approval evidence and is unsafe during an
  active import.
- Unit tests cover invalid bindings, owner check, SQL compare-and-set,
  failures and rollback, secret avoidance and fixed limits.
- The `PG_TEST_URL` suite uses real independent PostgreSQL sessions to
  prove concurrent claims, rollback versus commit, expiration and
  persistence across sessions; never call a mock-only run a concurrency proof.
- **Still open:** actual owner consent interaction and HTTP authorization,
  revoked-key recheck inside the apply client, target lock/serialization
  and all category/role/channel writes, failpoint recovery, replay
  policy on aborted imports and two independently deployed instances
  with TLS parity tests.

No change to the 90% coverage threshold, assertion severity or skip policy.
