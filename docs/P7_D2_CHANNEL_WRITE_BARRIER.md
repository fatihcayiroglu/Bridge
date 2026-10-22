# P7 D2 — authoritative channel write barrier (migration 085)

Every write of channel content is checked by PostgreSQL inside the writing
statement, whatever application path issued it. No expiry API, worker or UI
is enabled; channels stay permanent unless `expiresAt` is set in SQL.

## Why a database barrier

The writer audit found at least 12 application paths that insert channel
messages (socket send and file send, bridge relay copies, scheduled
dispatch, AutoMod alerts and logs, bot interaction replies, incoming
webhooks/bots, plugins, onboarding welcome, server templates, permission
logs, voice messages) plus a raw-SQL crosspost and separate thread tables.
All are autocommit single statements or their own transactions. Wiring an
application lock helper (#349) into each would leave future writers
unprotected; a check in the table itself cannot be skipped by any of them.

## Design

`bridge_channel_write_barrier()` runs as an ordinary `BEFORE INSERT OR
UPDATE` row trigger on `messages`, `thread_messages` and `threads`.

- **Not deferrable.** Ordinary triggers are not constraint triggers, so
  `SET CONSTRAINTS` cannot move or skip them; the bypass demonstrated by the
  deferred-trigger experiment in #351 does not apply (tested).
- **Lock order:** `SELECT … FROM channels … FOR KEY SHARE` first, then the
  tombstone, then expiry against `clock_timestamp()`. The expiry worker must
  take `FOR UPDATE` on the channel before writing the tombstone and deleting
  the graph. A writer that locked first commits before the worker can claim,
  and the worker's later delete removes what it wrote; a writer that arrives
  during the claim waits, then sees the row gone and the tombstone committed,
  and is denied. `FOR KEY SHARE` does not conflict with ordinary channel
  `UPDATE`s, so busy channels gain no contention against metadata edits.
- **Rules** (mirror `classifyChannelExpiryWithTombstone`): tombstone → deny;
  channel under another server → deny; `expiresAt` with `expiryVersion <= 0`
  → deny; `expiresAt <= now` → deny; no channel row and no tombstone → allow
  (pre-D2 behaviour, `messages.channelId` has no FK).
- **Updates** are denied by default on an unavailable channel. One passes
  only when EVERY column it changes is a recognised erasure step
  (`bridge_channel_update_is_erasure`, judged per column on OLD and NEW):
  author display fields; `deletedAt` set (never cleared, so no undelete) with
  `deletedBy`; payload columns scrubbed to NULL/empty/`[Mesaj silindi]` by a
  soft delete; `replyTo` cleared or narrowed to a subset of itself plus
  `deleted=true`; `embedding` cleared. Account erasure, the soft-delete scrub
  and cleanup are never blocked, but a soft delete cannot carry new content,
  reactions, pins or edit history. `DELETE` is not guarded.
- **Moves:** changing `channelId`/`serverId` is a write to BOTH channels, so a
  row can neither be moved into an unavailable channel nor rescued out of one
  before cleanup.
- **Correction (follow-up to #356):** the first version returned early on any
  `deletedAt` NULL→value transition and allowed arbitrary `replyTo` and
  `embedding` writes, so `UPDATE ... SET "deletedAt"=..., content='new'` on an
  expired channel committed. A regression now fails against that trigger and
  passes against this one. The embedding eligibility predicate
  (`EMBEDDABLE_ROW_PREDICATE`) also excludes expired and tombstoned channels, so
  their text is never sent to the embedding provider.
- **Contract:** denial raises SQLSTATE `BX001`. HTTP routes answer 404
  "Channel not found" (global error handler); socket handlers emit the
  existing terminal `CHANNEL_NOT_FOUND` code, which current clients already
  render and which stops offline-outbox retries.

## Evidence

- `server/tests/pg-integration/channel-write-barrier.pgtest.ts` (14 cases,
  real PostgreSQL): trigger kind; permanent/active/legacy allowed; expired,
  tombstoned, tenant-mismatched and corrupt denied; database-clock boundary;
  `SET CONSTRAINTS` cannot defer or skip; `ON CONFLICT` replay denied;
  update rules incl. the real soft-delete scrub; soft-delete/housekeeping
  smuggling, move-out, undelete, reply-snapshot and embedding writes denied;
  embedding eligibility excludes expired/tombstoned channels; real `Messages.create`,
  `Threads.insert`, `Threads.insertMessage`, `Announcements.persistCrosspost`
  (whole crosspost transaction rolls back); worker-first and writer-first
  races; no contention with metadata updates.
- `server/tests/channel-write-barrier.test.ts`: HTTP and socket mapping.
- Migration rollback gate: 085 is lossless. The triggers name no columns; an
  `UPDATE OF` list made earlier migrations' rollbacks fail.

## Limits

- Commit-time precision: the check runs at statement time. A transaction
  that passes just before `expiresAt` may commit just after it; such rows are
  invisible to readers (#352-#355 read preflights) and are removed by the
  worker's delete, which cannot start until the writer finishes.
- Every writer must keep sending the channel's real `serverId` (tenant check).
- Expiry edits by an owner are plain `UPDATE`s and do not wait for in-flight
  writers; the worker claim (`FOR UPDATE`) does.
- Not yet built: expiry configuration API, the cleanup worker, object-store
  outbox, offline/federation convergence (#321).
