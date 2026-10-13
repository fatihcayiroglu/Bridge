# P7 C4 — same-client locked signed mapping and destination grant review

**Unconnected internal verifier. No HTTP approval, no consent token, no
migration writes, no user-facing import.** This is one guarded part of issue
#205, not a complete atomic importer.

`inspectLockedPortableImportReview` requires a caller-owned PostgreSQL
`SERIALIZABLE READ WRITE` transaction and accepts exactly one physical
database client. Within that client it:

1. Locks the destination owner row and refuses absent or different ownership.
2. Reads and locks the full bounded category/role/channel topology. Normalizes
   PostgreSQL BIGINT order values, permission masks and integer NSFW flags
   without lossy coercion. Checks the exact complete v1 destination digest.
3. Independently re-verifies the Ed25519 source signature using the operator's
   pinned/revocable trust registry, the paired manifest hashes and explicit
   category/role/channel ID links. The static policy rejects privilege
   widening, unsupported grants and elevated source roles.
4. On that **same client**, checks every mapped destination channel permission
   grant with strict parity, including `@everyone` and legacy rows.
5. Returns only a source review fingerprint and two target digests, with
   `consentIssued:false` and `writesPerformed:false`.

The caller MUST provide the operator trust registry from server configuration,
never from the request. As a future apply primitive, this must be called
*inside the same SERIALIZABLE transaction as owner step-up checks, the one-use
approval claim and all destination writes*. The current function does not
prove that its caller actually performed fresh `account.import` step-up,
and neither reviewer fingerprint nor a digest is authorization.

**Still open:** source issuance replay controls, explicit consent route,
binding current grant digest + exact topology to durable consent, the
single-transaction importer, category/role/channel apply semantics,
failpoint recovery, and two independently deployed TLS installations.

The real PostgreSQL test locks live destination channel rows against a
concurrent writer and checks changed target grants and owner mismatch.
This is not evidence that a read-only transaction alone prevents all
phantom inserts: the final importer must write inside SERIALIZABLE and
prove serializability/retry, rollback and permissions after COMMIT.

Do not mark P7 complete or relax security/coverage gates.
