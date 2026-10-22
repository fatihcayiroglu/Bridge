# P7 D2 — channel expiry worker

`server/lib/channelExpiryWorker.ts`, driven every 60 s by
`server/jobs/channelExpiry.ts` on every node. Depends on the write barrier
(migration 085, #356): without it a late writer could still insert into a
tombstoned channel. Expiry is set through the owner-only API
(`docs/P7_D2_CHANNEL_EXPIRY_API.md`); when nothing is due, each tick is one
indexed query (migration 086) that finds nothing.

## Phases

1. **Claim** — one O(1) transaction per channel: FOR UPDATE SKIP LOCKED on
   one expired, untombstoned channel (other nodes skip it), a live sibling
   locked FOR KEY SHARE SKIP LOCKED (the server keeps a channel) and the
   durable tombstone (`cleanupState = 'pending'`). The channel row is **not**
   deleted here: its FK cascades (`message_reports`, `channel_read_positions`,
   `server_events`) are unbounded and used to run inside the claim. From this
   commit reads deny (read preflights), writes deny (barrier checks the
   tombstone first), listings hide the row (its `expiresAt` has passed), the
   expiry API answers 404 (tombstone) and ordinary deletion answers
   `not_found`. The tombstone's primary key is the authoritative claim: a node
   whose row lock is granted just after another node committed (its
   `NOT EXISTS` uses the old statement snapshot) gets `ON CONFLICT DO NOTHING`
   and reports `raced`, so a claim is never reported or announced twice.
2. **Cleanup** — bounded passes: lock the oldest pending tombstone
   FOR UPDATE SKIP LOCKED, delete at most `batchSize` rows from every table
   with a `channelId` column, every table whose single-column FK references
   `channels` (discovered from `pg_constraint`, e.g. `server_events.channel_id`),
   the channel edges (bridges, follows, crosspost log) and channel saved items.
   A pass that deletes nothing deletes the channel row — its cascades now
   find nothing — and marks the tombstone `converged`. Every step is
   idempotent and durable, so crashes, retries and concurrent nodes are safe.
   Attachment files are released by the existing reference-based upload
   cleanup once no row references them.

Lock order matches the write barrier (channel row first). A writer holding
the channel's `FOR KEY SHARE` makes the claim skip that channel for the tick;
cleanup removes whatever the writer committed.

**Last-channel invariant:** `ChannelRepository.deleteGraphAtomic` counts only
live siblings (not expired, not tombstoned), so a lingering claimed row can
never let an owner delete the server's last live channel.

## Evidence (real PostgreSQL)

`server/tests/pg-integration/channel-expiry-worker.pgtest.ts`: claim plus
convergence of messages, threads, thread replies, notifications and saved
items with siblings untouched; reads and writes denied right after the
claim; last live channel never claimed; four concurrent workers claim each
of 12 channels exactly once; writer-held channel skipped then cleaned;
crash mid-cleanup with batch size 2 resumes and converges; converged
tombstones are not reprocessed; the claim leaves 5 read positions, 4 reports
and 3 server events intact (no cascade), a tombstoned channel is never
claimed twice, the expiry API and ordinary deletion refuse it, it does not
count as a surviving channel, and batch size 2 drains the FK tables before the
row is deleted while the audit row survives. Rollback gate: 086 lossless; isolated 084
reversal is a declared `EXPECTED_DEPENDENCY` on 086.

## Owner decisions / not built

- **Last live channel:** never claimed. Whether such a channel may expire
  (refused at configuration time, or replaced by a fresh default channel)
  is a product decision for the expiry API.
- **Moderation evidence (explicit policy):** an expired channel's
  `message_reports` are deleted with its content, in bounded batches, exactly
  like ordinary channel deletion (their `channelId` FK cascades). Security
  `audit_logs` are retained. Keeping reports (and #345's evidence snapshots)
  beyond channel expiry would require relaxing `message_reports.channelId`'s
  FK and is an owner decision tied to #345; until then an ephemeral channel
  is not a place where reports outlive the content.
- Not built: expiry configuration API/UI, live notification of connected
  clients when a channel expires (they see 404/`CHANNEL_NOT_FOUND`), search
  index/embedding cleanup beyond row deletion, federation tombstone
  propagation, offline-client tombstone sync.
