# P7 C4 — two independent TLS installations, full signed round trip

**Scope:** the existing-row metadata import that Bridge actually supports
(see [P7_PORTABLE_IMPORT_SCOPE.md](P7_PORTABLE_IMPORT_SCOPE.md)), run end to end
between two separately deployed installations. Unsupported classes such as
members, messages, files, grants and row creation are not transported. This
evidence does not claim they are.

## Setup

`scripts/federation-lab/run.mjs --scenarios portable` reuses the federation lab:

- **Two production-mode Bridge processes** (A and B). Each has its own
  PostgreSQL cluster, Redis server and uploads directory.
- **Real HTTPS** on each, behind its own TLS front with a DNS name and a lab CA.
  The client pins that CA.
- **A's Ed25519 signer is generated before either process starts.** B's
  operator registry receives only A's public SPKI. B never learns a key from
  the artifact, a Host header or the request.
- **B is configured by its operator** with two flags:
  `BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED=true` and
  `BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED=true`. Both stay default-OFF in
  production.
- **Credentials come from real password sign-ins.** The step-up grants
  (`sensitive-export`, `account-security`) are reused for at most 90 s,
  below the server's 120 s freshness bound.
- **Production rate limits stay ON.** The scenario paces itself below
  them: login is 10/min per IP and `limits.write()` is 30/min per account.
  CSRF tokens are reused the way a real client reuses them.

Every check reads B's **own PostgreSQL rows** directly. Those rows are the
categories, roles (including permission masks), channels,
`channel_permissions`, legacy overrides, members, the approval ledger, the
snapshot-consumption barrier and `audit_logs`. HTTP status alone never
passes a check.

## Flow and assertions (`P7-RT-xx`, after `P7-TLS-01..07`)

The community data is set up as follows:

- **Source A:** a collapsed category; a role with a colour; an NSFW text
  channel with a topic, a 30 s slowmode, a legacy category label and a
  category link; a voice channel; and a role deny-override on the text
  channel.
- **Category link seeding:** no public API assigns a channel to a
  category by ID, so that one link is seeded in A's own database.
- **Destination B:** independently created rows of the same shape, with
  different values.

| ID | What is proven |
|----|----------------|
| RT-01 | The owner reviews A's signed snapshot against B's live topology fingerprint over HTTPS. No widening and no unsupported grant rows. |
| RT-02 | Approval is refused while B's grants differ from the signed, mapped grants. The ledger is unchanged. |
| RT-03 | A B edit after review makes the stale approval fail closed. |
| RT-04 | A nonowner on B gets 403. |
| RT-05 | Approval creates exactly one unconsumed ledger row with a TTL of ≤ 120 s and no plaintext token. Topology is untouched. |
| RT-06 | A forged token changes nothing and does not consume the real approval. |
| RT-07 | An apply sent during a network outage in front of B leaves B untouched. |
| RT-08 | After a **SIGKILL of B**, B keeps the committed, unconsumed approval and unchanged rows. |
| RT-09 | After restart, the approved apply commits once. The approval is consumed and there is +1 snapshot barrier row and +1 audit row. |
| RT-10 | B's rows equal A's snapshot rows field by field. Role masks, grants, member count and row counts are unchanged. |
| RT-11 | B holds the **signed snapshot** value, not A's edit made after export. |
| RT-12 | The audit row carries counts only: no token, owner ID, source IDs or signature. |
| RT-13 | A replay of the consumed token is refused and nothing changes. |
| RT-14 | A **fresh** approval of the same signed snapshot (201) still cannot apply it (422). This is the durable snapshot barrier. |
| RT-15 | B's re-export over TLS reproduces A's signed topology **and** the mapped grants. |
| RT-16 | Two simultaneous applies of one approval give 200 + 422 and commit exactly once. |
| RT-17 | An expired approval is refused even with a brand-new owner step-up. |
| RT-18 | The client cuts the connection after B receives the full apply request. B commits (its answer is 200, never delivered) and the client's retry gets 422, so the apply happens exactly once. If B had not committed, the retry would have to apply once; the check accepts only those two all-or-nothing outcomes. |
| RT-19 | After a graceful B restart, the applied rows persist and the consumed token stays refused. |
| RT-20 | After the operator **revokes** A's key (B restarted with `revoked: true`), the review, a new approval **and the already outstanding approval** are all refused. |
| RT-21 | A snapshot signed by an **unpinned key** for the right origin and community is refused. This includes substituting it under a legitimately reviewed fingerprint. |
| RT-22 | A's and B's logs contain no approval token, step-up grant or source private key. |

## Product defect found and fixed by this run

`buildPortableCommunityStructure` exported `nsfw: channel.nsfw === true`.
PostgreSQL stores `channels.nsfw` as `INTEGER 0/1`, and repository rows carry
it as a number, so:

1. **Wrong export.** Every unsigned `GET /portable-export` reported NSFW
   channels as `nsfw: false`.
2. **Approvals blocked.** For **any destination holding an NSFW channel**,
   the route-side target digest (repository rows, `1 → false`) never matched
   the in-transaction digest (normalized, `1 → true`). Every owner approval
   then failed closed. The live lab hit this on the second round, after the
   first apply had made a B channel NSFW. The existing unit fixtures used
   boolean `nsfw`, so they missed it.

**Fix:** INTEGER `0`/`1`, booleans and an absent value now map to a strict
boolean. Any other encoding fails closed with a `TypeError`.

**Regressions** (each fails without the fix):

- Builder: `1 → true`, `0 → false`, equal digests to the boolean forms, and
  refusal of `2`, `-1`, `'1'`, `'true'` and `{}`.
- Route: an INTEGER-1 channel exports as `nsfw: true`.
- Locked review: an INTEGER-1 target channel produces the same digest as
  the route path.

## What this does NOT establish

- **Not real-world domain ownership.** The lab CA proves transport
  authenticity in the lab only.
- **No row creation or full replacement.** The scenario does not create
  destination rows or replace a whole community.
- **Not a broken TCP stream during PostgreSQL COMMIT.** That case is
  covered separately by the PostgreSQL acknowledgement-loss regressions.
  RT-18 cuts the client connection, not the database link.
- **Not an owner UI.** The flow uses the HTTP API that a UI would call.
- **Not physical-device or desktop evidence.**
