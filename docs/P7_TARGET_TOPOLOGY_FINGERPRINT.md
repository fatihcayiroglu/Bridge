# P7 C3 — Destination topology fingerprint binding

**Status: read-only preflight only; import remains unimplemented.**

Two owner-protected APIs now share a canonical, deterministic SHA-256
fingerprint of the **currently read destination topology**.

1. `POST /api/servers/:sid/portable-import/paired-preview` returns
   `targetTopologyDigest` (64 lowercase hex characters) alongside
   its source topology/permission comparison.
2. `POST /api/servers/:sid/portable-import/mapping-review` now requires
   the mapping object to include `expectedTargetDigest` **exactly equal**
   to the current target fingerprint. A missing, malformed or stale value
   is rejected with 422 and no mapping details are returned.

The hash canonically sorts each resource type by stable ID and includes the
destination server ID, each category's ID and name, every role's ID/name/
canonical permission bitmask, every channel's ID/name/type and optional
category ID (null when absent). It does not include members, messages,
secrets, audit records, or user-specific overrides. Rows must belong to
the same destination, use valid bounded IDs/names/masks, and have unique
IDs per collection. A channel whose category reference is not present
in the category snapshot makes the fingerprint unavailable rather than
pretending the target is consistent.

**Read-only request sequence:**
- The destination owner authenticates with fresh `account.import`
  step-up proof and submits two valid source files to `paired-preview`.
- The owner explicitly selects existing destination category/role/channel
  IDs. The next `mapping-review` request includes both source digests
  and the previously returned `targetTopologyDigest` as
  `mapping.expectedTargetDigest`.
- If destination topology changes, the mapping review fails closed.
  Even if unchanged, the report always returns `mappingApproved: false`,
  `importSupported: false`, `writesPerformed: false`.

**Important limits:** This is a cryptographic fingerprint of *selected
fields*, **not** a signed revision, serializable transaction or proof of
source authenticity. The reads of categories/roles/channels are not
guaranteed to share an atomic PostgreSQL snapshot. Simultaneous target
changes, grant/deny override changes, member records and other omitted
attributes may not change the fingerprint. An ABA change (value changes
and returns to the same value) also remains undetectable. The SHA-256
digest cannot be used as an authorization token or as a basis for
performing writes.

A future import must revalidate all source data, destination identity,
owner privileges, permission policy and snapshot/version **inside one
PostgreSQL transaction**, using the same DB client and a proper
transactional concurrency gate. Full rollback/failpoint evidence and
two independently deployed instances remain mandatory.
