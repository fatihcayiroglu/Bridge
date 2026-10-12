# P7 C3 — Destination topology fingerprint binding

**Status: read-only preflight only; import remains unimplemented.**

Three owner-protected APIs now share a canonical, deterministic SHA-256
fingerprint of the **currently read destination topology**.

1. `POST /api/servers/:sid/portable-import/paired-preview` returns
   `targetTopologyDigest` (64 lowercase hex characters) alongside
   its source topology/permission comparison.
2. `GET /api/servers/:sid/portable-import/target-fingerprint` returns
   `targetTopologyDigest` with resource counts **without uploading source
   exports**. Requires authenticated destination ownership and a fresh
   `account.import` step-up. No-store; no SQL writes.
3. `POST /api/servers/:sid/portable-import/mapping-review` requires
   the mapping object to include `expectedTargetDigest` **exactly equal**
   to the current target fingerprint. A missing, malformed or stale value
   is rejected with 422 and no mapping details are returned.

The fingerprint reuses the **entire C2 v1 portable structure field allowlist**
in deterministic sorted order, with a fixed snapshot timestamp: destination
server ID; category ID/name/position/collapsed state; role ID/name/color/
position/permission bitmask; channel ID/name/type/topic/category reference/
legacy category/order/NSFW/slowmode. The response is bounded at 512 KiB.
Rows must have destination provenance, unique valid IDs and valid role masks. It does not include members, messages,
secrets, audit records, or user-specific overrides. Rows must belong to
the same destination, use valid bounded IDs/names/masks, and have unique
IDs per collection. A channel whose category reference is not present
in the category snapshot makes the fingerprint unavailable rather than
pretending the target is consistent.
Unknown extra row fields (members, secrets, API tokens) are not hashed.

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


## Discord-style role ownership and delegation contract

Bridge server roles are **defined by the server's owner or by a delegated
administrator with `MANAGE_ROLES`**. The existing roles API enforces
`canManageRole`/role-position hierarchy and prevents a delegated role
manager from granting permission bits they do not already possess.
The special `@everyone` role represents the server baseline; channel-level
allow/deny overrides follow the existing effective-permission resolver.
Users and bots must never acquire administrative powers merely because a
source community has a role with a matching name or ID.

**Portable identity rule:** source role IDs/names/colors/masks are *reference
data only*. The destination's authorized server administrator decides which
destination roles to create, edit, or map, and which destination members may
receive them. No preview or fingerprint may create a role, assign members,
reorder hierarchy, copy dangerous `ADMINISTRATOR` grants, change channel
overrides or bypass `MANAGE_ROLES` checks. A matching title such as
"Moderator" is never permission to merge role privileges.

Current P7 portable preview/mapping endpoints deliberately require the
**destination owner with fresh `account.import` step-up**. Delegation of
community-wide imports to an administrator has **not** been implemented or
approved. Before any such delegation, enforce the same role hierarchy and
non-escalation rules as `server/routes/roles.ts`, plus independent approval
for privileged permission changes, durable authorization, audit and
transactional rollback. Do not silently reinterpret a `MANAGE_ROLES` grant
as permission to perform a whole-community import.
