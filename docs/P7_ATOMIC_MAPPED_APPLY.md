# P7 C4 — atomic mapped metadata apply (INTERNAL, NO HTTP ROUTE)

**Not publicly enabled and not P7 closure.** This PR adds the first
write-capable, internal-only destination apply helper. It does not replace
existing server/community ownership, user accounts, memberships, messages,
bots, moderation records, permission grants or role hierarchy.

`applyApprovedPortableCommunityMapping` requires a trustworthy server-side
authenticated owner identity, a recently re-verified `account.import`
credential grant, the operator's pinned Ed25519 source registry (not a request
key), the *same* signed paired manifests/mapping, a one-use staged token, and
the exact owner-confirmed review fingerprint.

One physical `SERIALIZABLE` PostgreSQL client:
1. Reads/locks current user factor/token version and proves a fresh scope and
   continuous open PG transaction ID
2. Rechecks source signing-key revocation, pair digests, current server owner,
   entire bounded destination topology, all mapped permission grants
3. Claims the SHA-256-hashed approval via its exact field-by-field,
   unexpired, unconsumed compare-and-set
4. Updates existing mapped **category labels/positions/collapse**, **role
   labels/colors only**, and **channel names/topics/category links/order/NSFW/
   slowmode**. No new destination IDs; target role `permissions` and
   `position` (hierarchy), role/user grants, and actual membership are untouched
5. Rechecks exact canonical channel grant parity on the SAME client; COMMIT
   atomically with approval claim. A failure ROLLBACKs token claim and ALL
   category/role/channel updates, discards a client on failed ROLLBACK.
   No success is returned before COMMIT.

**Intentional scope limit:** this is safe in-place mapping of existing rows,
not creation of new roles/channels, replacement of an arbitrary community, or
a full re-creation of source membership, messages, roles/hierarchy and grants.
Existing unmapped target rows remain unchanged. Full source/target topology
parity is **not** claimed. This difference must be visible to any future UX.

Real PostgreSQL acceptance includes deterministic failpoints after claim,
categories, roles, channels and before commit, snapshot equality and
approval-not-consumed assertions after every rollback. A token remains
usable after a failed rollback and a committed token cannot be replayed.
Unit tests cover failed COMMIT and stale/fraudulent proof/permissions.

**UNMET acceptance gates:**
- An authenticated, operator-controlled HTTP apply route with deliberate UI
  confirmation and *independent* approval-token confirmation
- Feature capability and restricted in-place mapping UI that tells the
  owner no memberships, role permission/hierarchy, grants or messages migrate
- Source-side independently deployed signing service, key rotation, replay
  and consistent snapshot beyond current internal foundation
- Two separately deployed TLS Bridge installations with end-to-end
  export -> review -> consent -> apply -> re-export equality checks
- Concurrent insertion/mutation, outage/process crash and network
  unknown-COMMIT outcome reconciliation evidence

No route is mounted in this PR, and issue #205 remains open.
