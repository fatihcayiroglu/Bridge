# P7 C4 — destination grant parity inside a caller-owned transaction

**Status: unmounted contract. No approval endpoint, importer, data writes or
permission migration are enabled by this PR.** This is a necessary guard for
issue #205, not the complete solution.

`requireMappedDestinationGrantParity` takes a caller-provided PostgreSQL
client and rejects the operation unless that very client already operates in a
`SERIALIZABLE READ WRITE` transaction. It locks the destination OWNER row,
mapped channels and roles, and every existing mapped canonical grant. It
rejects missing grants, modified permissions, extra/duplicate overrides,
unmapped target roles, legacy overrides and unknown/overlapping masks.
`@everyone` is normalized across the canonical destination server ID and
synthetic marker, but two representations at once are rejected.

The helper reads an *exact* channel grant set: any unknown grant is a blocker
rather than something to drop or map by role name. The result is a
domain-separated digest of the current mapped target grant set and explicit
flags `importSupported:false` / `writesPerformed:false`. This digest is
NOT a consent token or a replacement for the versioned topology fingerprint.

An actual importer must independently:
1. Verify fresh destination owner `account.import` step-up, independently
   pinned source Ed25519 proof, source pair atomicity, registry revocation
   and all explicit mapping choices.
2. Re-read/lock the **entire** target topology, hierarchy and relevant
   permission state in the same SERIALIZABLE client, not a read-only HTTP
   preflight's pool connection.
3. Recheck this exact grant parity and all dynamic authorization before
   claiming the already-implemented single-use ledger token.
4. Apply all categories/roles/channels/overrides on that same transaction;
   verify post-state parity and commit atomically, with real failpoint
   rollback and replay evidence.

The requirement to preserve preexisting grants remains strict. A grant that
cannot be mapped safely blocks import. Memberships, identities, messages,
attachments, secrets and legacy/user-specific grants are not migrated.

The live PostgreSQL test is scoped to a disposable schema and proves the
in-transaction lock rejects a competing writer; it does not claim
two-independent-deployment end-to-end acceptance.
