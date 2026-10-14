# P7 C4 — portable community import: supported scope and refusal rules

This is the product decision for which community data may cross from one
Bridge installation to another, and under which security, consent and
ownership rules. The rule is **move only what the destination owner can
safely own on their own**. Everything else is either refused explicitly or
never serialized.

## Supported today (implemented, default-OFF, operator opt-in)

These fields are applied onto destination rows **that already exist**, are
of the same kind (channels: the same type) and were mapped one-to-one by the
destination owner:

| Class | Fields applied | Never changed |
|-------|----------------|---------------|
| Categories | name, position, collapsed | — |
| Roles | name, colour | permission mask, hierarchy position |
| Channels | name, topic, category link (translated through the mapping), legacy category label, order, NSFW, slowmode | type, grants, messages |

These preconditions are **verified, not transferred**:

- **Channel grants.** The destination's `channel_permissions` must already
  equal the signed source overrides, translated through the mapping (grant
  parity). If any legacy or user-specific `channel_overrides` row exists on
  either side, the import is refused.
- **Role power.** A destination role wider than its mapped source role is
  flagged (`TARGET_ROLE_PERMISSION_WIDENING`) and cannot be approved. The
  same applies to source roles or grants carrying privileged bits
  (`ADMINISTRATOR`, `MANAGE_ROLES` and so on).

Live proof on two independent installations is in
[P7_LIVE_TLS_ROUND_TRIP.md](P7_LIVE_TLS_ROUND_TRIP.md).

## Explicitly NOT supported, and why

| Class | Decision | Reason |
|-------|----------|--------|
| **Creating** categories, roles or channels | Not implemented; the owner must create the target rows first | Creation needs its own permission-consequence review. Silent creation is how imports usually escalate. |
| Community name, description, icon | Exported for review, never applied | Server identity is the destination owner's decision. |
| **Memberships** and member-role assignments | Never serialized | Joining a community is each user's own decision. No user is enrolled, re-authenticated or assigned a role elsewhere. |
| **Identities** (accounts, sessions, credentials) | Never part of a community import | Users carry their own profile with the separate, self-initiated [portable identity](P7_PORTABLE_IDENTITY_V1.md) flow. No account is linked or logged in on the other installation. |
| **Message history** | Not transported | Every author's consent, retention and moderation state would have to move with it. A source owner cannot grant that on behalf of all authors. |
| **Files and attachments** | Not transported | Same consent issue, plus destination storage quotas and malware scanning. |
| **Permission grants** (channel overrides) | Never written; parity verified instead | Writing grants from a foreign artifact is privilege escalation by construction. |
| Legacy / user-specific overrides | Import refused while any exist | They cannot be translated without naming individual users. |
| **End-to-end-encrypted content** | Never moved | Servers do not hold the keys, and moving ciphertext without them is useless and leaky. |
| Bots, webhooks, invites, moderation records, audit history, emoji | Never serialized | They are credentials, abuse surface or historical records, not structure. |

## Security, consent and ownership rules

1. **No implicit trust.** A source is trusted only through an
   operator-pinned, revocable Ed25519 key for an exact HTTPS origin and
   community ID. A key from the artifact, a Host header or the network is
   never trusted. Revocation also cancels approvals that are already
   outstanding.
2. **Owner-only, fresh proof.** Only the current destination owner can
   review, approve or apply. Approval and apply each need an `account.import`
   step-up proof no older than 120 s, checked again inside the write
   transaction.
3. **Explicit consent bound to what was shown.** The approval is bound to:
   - the review fingerprint;
   - the live target topology and grant digests;
   - the source origin, server, snapshot and key;
   - both manifest digests.

   The approval is a one-use, hashed, ≤ 120 s ledger row. Any change after
   review fails closed.
4. **Atomic.** The token claim, the snapshot barrier, every update and the
   audit row run on one SERIALIZABLE PostgreSQL connection. They commit or
   roll back together. An ambiguous COMMIT discards the connection and never
   reports success.
5. **Exactly once per snapshot.** A durable
   `(target, origin, source server, snapshot)` barrier refuses any second
   apply of the same signed snapshot, even with a fresh approval.
6. **Redacted audit.** Audit rows hold counts and mode only: never tokens,
   owner IDs, source IDs, signatures or mapping contents.

Supporting any class listed in the "NOT supported" table needs its own
acceptance criteria: a consent model, an escalation analysis and
two-installation evidence. It must not be added as a side effect of this
import.
