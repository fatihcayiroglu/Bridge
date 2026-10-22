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
- **Updates** are denied by default on an unavailable channel, except a soft
  delete (row gains `deletedAt`, which scrubs its payload) and updates that
  only change housekeeping columns (author display fields, `replyTo`,
  `deletedAt`/`deletedBy`, `embedding`), so account erasure and cleanup are
  never blocked. `DELETE` is not guarded. Moving a row into an unavailable
  channel is a write to it and is denied.
- **Contract:** denial raises SQLSTATE `BX001`. HTTP routes answer 404
  "Channel not found" (global error handler); socket handlers emit the
  existing terminal `CHANNEL_NOT_FOUND` code, which current clients already
  render and which stops offline-outbox retries.

## Evidence

- `server/tests/pg-integration/channel-write-barrier.pgtest.ts` (11 cases,
  real PostgreSQL): trigger kind; permanent/active/legacy allowed; expired,
  tombstoned, tenant-mismatched and corrupt denied; database-clock boundary;
  `SET CONSTRAINTS` cannot defer or skip; `ON CONFLICT` replay denied;
  update rules incl. the real soft-delete scrub; real `Messages.create`,
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
