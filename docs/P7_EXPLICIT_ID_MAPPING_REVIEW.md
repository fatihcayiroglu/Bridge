# P7 C3 — Explicit community identity mapping review

**Status: read-only. No migration or apply endpoint exists.** This builds on
merged PRs #193–#195; a matching name in those previews is never considered
proof of shared identity.

## Endpoint

`POST /api/servers/:sid/portable-import/mapping-review`

The request must have exactly `targetServerId`, `structure`, `permissions`
and `mapping`. The first must equal the authenticated route `:sid`.
The two manifest documents must be the full checksum-valid C2 v1 exports
from the same source community. `mapping` must contain exactly:

```json
{
  "targetServerId": "destination-id",
  "structureDigest": "the 64-digit checksum from the structure file",
  "permissionsDigest": "the 64-digit checksum from the permission file",
  "categories": [
    { "sourceId": "source-category-id", "targetId": "existing-destination-category-id" }
  ],
  "roles": [
    { "sourceId": "source-role-id", "targetId": "existing-destination-role-id" }
  ],
  "channels": [
    { "sourceId": "source-channel-id", "targetId": "existing-destination-channel-id" }
  ]
}
```

These sample IDs are placeholders, not a valid complete request. Every source
category, role and channel must appear **exactly once**, and within each
kind an existing target ID can be used **at most once**. Missing, duplicate,
foreign and invented IDs, extra request keys or different source checksums
fail with 422. Target channel type must match. Destination child records
must belong to the requested destination and contain valid target IDs,
names and permission masks; invalid or missing data fails closed.

Authorization is the same strict owner+fresh `account.import`
(`account-security`) step-up as the paired preview. Unauthenticated
requests fail 401, nonowners fail 403, missing/wrong fresh proof fails 403
and route/body destination mismatch fails 409. The response is
`Cache-Control: no-store`.

The report returns the explicit source-to-target pairs, counts and
`rolePermissionWidening` findings. It detects when an existing
destination role has permissions absent in its mapped source role and
includes `TARGET_ROLE_PERMISSION_WIDENING` as a blocker. Names may differ:
an owner-selected destination ID is inspected, not silently inferred by
case-insensitive matching. No grant is copied or enabled by this report.

**Crucially, even with no missing references or widened role masks, the
report always says** `mode: read-only`, `writesPerformed: false`,
`importSupported: false`, `mappingApproved: false`.
Owner-submitted pairs and checksum strings cannot serve as authentication,
durable consent or reusable commit authority.

## Remaining P7 gates

- Source files need independently verifiable authenticity, and both files
  need a consistent source snapshot/version under concurrent modifications.
- Destination mapping choices must be recorded as tamper-evident, authenticated
  owner approvals tied to a **fresh target revision**, with replay protection.
- Channel overrides, `@everyone` visibility, unrelated target grants,
  role inheritance and per-user/legacy permission exclusions require a
  complete non-escalation policy. The role-level bitmask comparison in this
  review is **necessary but not sufficient**.
- Actual DB changes must be made in a single transaction on the same
  PostgreSQL client, rechecking ownership and target state inside it, with
  failpoint/rollback evidence.
- C4 requires two separately deployed Bridge installations and verified
  topology/permissions round-trip parity, not just a test in one database.
