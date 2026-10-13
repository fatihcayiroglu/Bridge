# P7 C4 — durable signed source snapshot replay barrier

**Status:** Restricted existing-mapped-metadata apply hardening; no full
community migration, no new source-key provisioning UI or independent TLS
instance acceptance.

The destination already required a fresh short-lived account.import step-up,
a pinned/revocable Ed25519 source attestation and a committed, one-use approval
token (#226–#229). But **one-use token is not one-use signed snapshot**:
a new token could otherwise authorize the same signed snapshot again.

Migration `083_portable_import_snapshot_replay_barrier.sql` introduces a
durable per-destination UNIQUE tuple:

`(target_server_id, source_origin, source_server_id, source_snapshot_id)`

with the verified source signing-key fingerprint and both manifest digests.
The signed identifiers come exclusively from the freshly, independently
verified source pair and the current destination lock, never arbitrary HTTP
metadata. The source snapshot ID is signed by the pinned origin/key, and the
source server identity is checked against the destination operator's explicit
choice. There is **no need to store the approval bearer token**.

The mapped importer INSERTs the tuple using `ON CONFLICT DO NOTHING
RETURNING` on its **same physical SERIALIZABLE PostgreSQL connection**
immediately after the approval CAS. A conflict, missing migration table,
other SQL error or invalid row count rejects the import and rolls back.
No metadata writes follow a failed replay barrier. UNIQUE provides
cross-worker/multi-instance exclusion without an in-memory cache.

A rollback at any of the five deterministic failpoints restores this
uncommitted replay reservation, approval claim, metadata and redacted audit
atomically. A successful COMMIT durably consumes it so **even an independently
issued second approval token cannot intentionally reapply this exact signed
snapshot to the same destination**. Different target communities may each
accept their own legitimately reviewed snapshot.

**Important scope:** The registry already supports operator-pinned,
time-bounded overlapping Ed25519 rotation and immediate revocation checks.
This PR does NOT provision/rotate the source's private keys or persist a
source-instance-wide key lifecycle. Nor does it prevent repeated read-only
export, signed review or approval staging; the replay barrier is at COMMIT
of an actual destination metadata apply.

Tests: unit fail-closed duplicate/missing DB replay barrier before any
metadata UPDATE, parameter binding checks, real PostgreSQL five-failpoint
rollback snapshots with zero persistent reservations, one durable
successful reservation, rejection of original and separately minted
approval tokens after apply, direct UNIQUE conflict proof. Adds a
reversible migration with explicit matching `.down.sql` and uses it
in real PG fixtures.

**Still missing for P7 #205:** owner-visible signed-mapping review UX,
independently deployed TLS source/target round-trip evidence (including
unknown-COMMIT recovery), production source key lifecycle and physical
mobile/macOS/Linux signoff. Do not mark P7 completed based on this PR.
