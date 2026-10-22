# P7 D2 — channel expiry worker

`server/lib/channelExpiryWorker.ts`, driven every 60 s by
`server/jobs/channelExpiry.ts` on every node. Depends on the write barrier
(migration 085, #356): without it a late writer could still insert into a
tombstoned channel. Expiry is set through the owner-only API
(`docs/P7_D2_CHANNEL_EXPIRY_API.md`); when nothing is due, each tick is one
indexed query (migration 086) that finds nothing.

## Phases

1. **Claim** — one short transaction per channel:
   `FOR UPDATE SKIP LOCKED` on one expired channel (other nodes skip it), a
   live sibling locked `FOR KEY SHARE SKIP LOCKED` (the server keeps a
   channel), durable tombstone (`cleanupState = 'pending'`), channel row
   deleted. From this commit reads deny (read preflights), writes deny
   (barrier), and FK-cascaded rows (read positions, server events, message
   reports) are gone.
2. **Cleanup** — bounded passes: lock the oldest pending tombstone
   `FOR UPDATE SKIP LOCKED`, delete at most `batchSize` rows from every table
   with a `channelId` column, the channel edges (bridges, follows, crosspost
   log) and channel saved items. A pass that deletes nothing marks the
   tombstone `converged`. Every step is idempotent and durable, so crashes,
   retries and concurrent nodes are safe. Attachment files are released by
   the existing reference-based upload cleanup once no row references them.

Lock order matches the write barrier (channel row first). A writer holding
the channel's `FOR KEY SHARE` makes the claim skip that channel for the tick;
the next claim removes whatever the writer committed.

## Evidence (real PostgreSQL)

`server/tests/pg-integration/channel-expiry-worker.pgtest.ts`: claim plus
convergence of messages, threads, thread replies, notifications and saved
items with siblings untouched; reads and writes denied right after the
claim; last live channel never claimed; four concurrent workers claim each
of 12 channels exactly once; writer-held channel skipped then cleaned;
crash mid-cleanup with batch size 2 resumes and converges; converged
tombstones are not reprocessed. Rollback gate: 086 lossless; isolated 084
reversal is a declared `EXPECTED_DEPENDENCY` on 086.

## Owner decisions / not built

- **Last live channel:** never claimed. Whether such a channel may expire
  (refused at configuration time, or replaced by a fresh default channel)
  is a product decision for the expiry API.
- **Moderation evidence:** deleting the channel row cascades its
  `message_reports`, exactly like manual channel deletion today. Retention
  of report evidence beyond channel deletion is the open B5 policy (#345).
- Not built: expiry configuration API/UI, live notification of connected
  clients when a channel expires (they see 404/`CHANNEL_NOT_FOUND`), search
  index/embedding cleanup beyond row deletion, federation tombstone
  propagation, offline-client tombstone sync.
