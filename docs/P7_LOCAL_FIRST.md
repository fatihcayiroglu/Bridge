# P7 — Local-first, encrypted offline state and sync

P7 starts from the P6 closure merge on `main`:

- P6 closure merge: `972f30cde9719d9285e2da9a448ccd7dbae97679`
- working `main` baseline: `36e9f9c35e45bff9991833e50588c0c57551b1af` (includes the post-P6 `postcss-selector-parser` security bump)
- P6 is closed; its federation/AI/self-hosting evidence remains frozen
- P7 branch: `p7/local-first-openai`

P7 is not a rewrite of Bridge messaging. It makes the existing server-authoritative
messaging model usable through network loss, reloads and intermittent mobile
connectivity without inventing a second source of truth.

## Non-negotiable invariants

1. **The server remains authoritative for security.** Local data never grants
   membership, channel access, moderation rights, message ownership or permission
   changes.
2. **Deletion and access revocation win over stale local state.** A cached message
   may be shown offline only if it was previously authorized; once the client
   learns that it is deleted or no longer viewable, it must be purged locally.
3. **No duplicate send semantics.** The existing `ackId` idempotency contract is
   retained. P7 must not create a second message queue beside the canonical
   `MessageInputPanel + outbox-store` path.
4. **Sensitive local state is encrypted at rest.** Plaintext message history,
   drafts and queued message bodies must not remain in long-lived
   `localStorage`.
5. **Account separation is strict.** Every local record is scoped to a stable
   account identity. Logout/account switch closes the active store, drops
   in-memory keys and prevents another account from reading the previous
   account's cache.
6. **Offline state is bounded.** History, operations, drafts and attachments have
   explicit quotas/retention. Quota failure degrades honestly; it never pretends a
   durable write succeeded.
7. **No CRDT by fashion.** Use an operation log and deterministic reconciliation
   first. Introduce a CRDT only if a measured multi-writer conflict cannot be
   represented safely by the server's current semantics.

## Baseline audit

Current production-reachable owners on the P7 baseline:

- `client/js/core/outbox-store.ts` — canonical durable send queue; currently
  persisted as JSON in `localStorage`, with an in-memory fallback.
- `client/js/core/draft-store.ts` — per-user/per-conversation drafts; currently
  persisted in `localStorage`.
- `client/js/core/MessageLoader.svelte` — network-first channel history loader
  and cursor pagination; live socket mutations are reconciled against in-flight
  snapshots.
- `client/sw.ts` — PWA cache/push support and an older IndexedDB outbox helper.
  It must not become a parallel canonical send queue.
- server message writes already have client-generated idempotency keys and the
  runtime has reliable reconnect replay; P7 builds on those contracts rather
  than replacing them.

## Workstreams

### W1 — Local database and key boundary

Create one local-first storage owner with:

- schema/version migrations;
- per-account database namespace;
- encrypted sensitive payload columns/envelopes;
- bounded history and operation-log retention;
- explicit `open / close / wipe account / wipe conversation` lifecycle;
- browser and Capacitor adapters behind one contract.

Target architecture:

- native Capacitor: SQLite-backed storage, with encryption/key material kept out
  of web storage and integrated with the platform secure-storage boundary;
- web/PWA: SQLite/OPFS where the runtime supports the required durability, with a
  tested fallback rather than silently claiming SQLite durability where it does
  not exist;
- encryption envelope independent of the physical backend so data is not exposed
  as plaintext merely because the backend changes.

The key threat model and exact browser/native key storage are closure items, not
implementation assumptions.

### W2 — Draft and outbox migration

Move the existing draft and canonical outbox records behind W1 without changing
their public behavioural contracts.

Required proof:

- plaintext legacy records migrate once and are removed only after a verified
  encrypted write;
- `ackId`, ordering, retry state and optimistic bubble behaviour remain stable;
- quota/blocked-storage cases retain the current honest in-memory degradation;
- no user can load another user's draft/outbox after account switching.

### W3 — Offline message history

Persist authorized message snapshots after a successful server load or live
socket event.

Offline channel open must:

- render the newest locally cached window immediately;
- label the view as offline/stale rather than implying server freshness;
- preserve ordering and pending optimistic messages;
- never resurrect a locally tombstoned/deleted message.

Reconnect must revalidate with the server and converge without duplicate bubbles.

### W4 — Operation log and reconciliation

Represent offline mutations as explicit operations with stable ids and states
(`queued / sending / applied / rejected / superseded`).

Initial operations:

- send message;
- edit own message;
- delete own message;
- reaction desired-state update;
- draft update stays local-only.

Conflict policy is operation-specific. Server rejection is surfaced to the user;
it is never overwritten by a local "last write wins" shortcut.

### W5 — Offline history search

Provide local search across the bounded authorized cache.

Rules:

- no cross-account index;
- deleted/revoked content is removed from the index;
- E2EE data is searchable locally only after the client has legitimately
  decrypted it; ciphertext is not sent elsewhere for indexing;
- online global/server search remains server-authoritative.

### W6 — Background sync and lifecycle

Cover:

- browser online/offline transitions;
- Socket.IO reconnect;
- tab/process reload;
- service-worker wake where supported;
- Capacitor background/foreground transitions;
- device clock skew and retry backoff.

There must be one replay owner per operation type and no double-send path.

### W7 — Trust, abuse and permission safety

Local-first must not weaken existing abuse controls.

Audit and lock:

- permission changes while a device is offline;
- ban/kick/channel deletion while cached;
- account deletion/session revocation;
- replay after moderation action;
- stale invite/link or DM targets;
- rate-limit behaviour during reconnect bursts;
- federation-originated content cached locally.

### W8 — Performance, evidence and rollback

Every major feature needs:

- unit tests for migrations/crypto/reconciliation;
- browser E2E for offline → reload → reconnect;
- mobile lifecycle evidence where CI can measure it;
- storage-size and startup-time benchmarks;
- reconnect convergence timing;
- corruption/recovery tests;
- rollback/export strategy for local schema migrations.

## First closure gates

P7 cannot close until all of the following are true:

| Gate | Required result |
|---|---|
| Plaintext draft/outbox at rest | removed from canonical long-lived storage |
| Offline reload | cached channel history opens without network |
| Reconnect convergence | no lost/duplicate message across offline send + reload |
| Permission revocation | stale cache cannot bypass the next server-authoritative check |
| Delete/edit convergence | server final state wins deterministically |
| Account switch | zero cross-account cached content exposure |
| Corrupt local DB | app recovers without losing server truth or entering a send loop |
| Storage pressure | bounded eviction; pending writes are never silently discarded |
| Search | local cached search honors deletion/account/channel boundaries |
| Quality Gate | green on final PR head and post-merge `main` |
| Evidence | measured P7 ledger records commands/runs and known limitations |

## First implementation order

1. W1 storage contract + crypto/key threat model + corruption tests.
2. Migrate drafts, because they are local-only and provide the smallest safe
   end-to-end proof of encrypted persistence.
3. Migrate the canonical outbox while preserving `ackId` semantics.
4. Add bounded message snapshots and offline channel open.
5. Add reconnect delta/reconciliation and explicit operation log.
6. Add local search.
7. Run abuse/permission, multi-tab, mobile lifecycle and performance evidence.
8. Final regression, closure ledger, merge and post-merge verification.

This order deliberately avoids changing message delivery and history at the same
time as the new storage substrate. Each layer must be measurable before the next
one becomes canonical.
