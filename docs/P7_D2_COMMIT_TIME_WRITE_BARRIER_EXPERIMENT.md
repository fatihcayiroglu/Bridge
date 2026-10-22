# P7 D2 — commit-time INSERT barrier experiment (not enabled)

**Status:** Test-only design evidence; issue #321 remains OPEN. There is no
expiry-enabled product API, no production trigger, no server write-path wiring
and no cleanup worker introduced by this change.

## Why test at the database boundary?

The channel-message writer audit found many producers using the generic
MessageRepository / PgCollection insert path and at least one direct-SQL
crosspost. Other channel-scoped content (including threads) has its own
persistence tables. Wiring only the socket sender would leave alternative
writers unprotected.

Migration 084 reserves nullable channels.expiresAt, expiryVersion and
channel_expiry_tombstones. Existing channels remain permanent. PR #348 adds
scheduled-send preflight; PR #349 proposes a separate transaction-scoped
lock helper, but neither makes ordinary production message inserts atomic.

## Hypothesis under test

A **deferred AFTER INSERT constraint trigger** on a channel-scoped table
can check eligibility late in the inserting transaction:

1. At COMMIT, look up channel by both channel ID and server ID.
2. Acquire a PostgreSQL FOR SHARE lock on its row; future expiry
   updates/deletes must use a conflicting row lock.
3. Reject missing, tenant-mismatched or invalid expiry/version metadata.
4. Reject **any** globally keyed tombstone for the channel.
5. Compare expiresAt to clock_timestamp() on the database server.
6. Throw a fixed database error so the entire message transaction rolls back.

The real-PostgreSQL test uses a unique throwaway schema with a small
representation of the production columns, installs the trigger there, and
drops the schema afterward. No trigger is installed on actual messages.

The deferred **AFTER** timing matters:
- An INSERT that precedes a concurrent expiry UPDATE in an open transaction
  can be rejected at COMMIT rather than passing an earlier application check.
- ON CONFLICT DO NOTHING inserts no row; its AFTER INSERT trigger does not
  run. This retains the storage idempotency contract. It does **not** grant
  the caller permission to read or acknowledge the previously stored message.
- FOR SHARE conflicts with worker FOR UPDATE operations; the worker must
  follow this locking discipline and acquire the channel lock before writing
  the tombstone. Arbitrary direct writes to tombstones without that lock
  remain an unproven race.

## Limits and unanswered design decisions

- Even deferred triggers check the clock immediately **before** COMMIT, not
  atomically with wall-clock time at the final commit record; a precise
  millisecond cutoff across long-running, externally controlled transactions
  is not established.
- A trigger has per-row insert overhead and may alter lock contention.
  Measure representative message batches (p50/p95) before enabling.
- SET CONSTRAINTS ... IMMEDIATE can execute a deferred trigger earlier
  inside a transaction; restrict the DB writer role and establish a
  production-proof transaction/authorization contract before relying on it.
- Direct channel ID reuse after cleanup needs a durable tombstone invariant
  at channel-creation time too.
- A same-transaction expiry edit could change metadata after a trigger was
  fired early; guard its mutation path and ensure no bypass via privileged
  trigger changes or roles.
- READ/access control, UPDATE, crossposted duplicates, threads, reactions,
  attachments, offline queues, federation and replica behavior are NOT
  protected by this candidate INSERT-only trigger.
- The production messages table has unique ACK/scheduled indexes;
  production migration/replay, security, multiworker, S3/outbox and
  performance tests are still required.
- #349's helper and this experiment are alternative/complementary
  primitives. Decide on one consistent lock and error contract before
  integrating either; do not blindly nest both transaction mechanisms.

## Evidence gate

PG_TEST_URL=... npx jest --config jest.pg.config.js --runInBand
tests/pg-integration/channel-expiry-commit-guard.pgtest.ts

The CI real-PostgreSQL suite is the proof. A passing TypeScript/unit suite
alone does not establish trigger semantics. Any skip is **not a pass**.

**Next authorized implementation:** review the design and failure behavior,
choose a consistent transaction/lock strategy, add a production migration
with upgrade/rollback plan and all-channel-writer coverage, then wire
authorization and cleanup in separate verified changes. Leave ephemeral
channel creation disabled until end-to-end D2 closure.
