# P7 D2 — channel expiry worker

`server/lib/channelExpiryWorker.ts`, driven every 60 s by
`server/jobs/channelExpiry.ts` on every node. Depends on the write barrier
(migration 086, #356): without it a late writer could still insert into a
tombstoned channel. Expiry is set through the owner-only API
(`docs/P7_D2_CHANNEL_EXPIRY_API.md`); when nothing is due, each tick is one
indexed query (migration 087) that finds nothing.

## Phases

1. **Claim** — one O(1) transaction per channel: FOR UPDATE SKIP LOCKED on
   one expired, untombstoned channel (other nodes skip it), a live sibling
   locked FOR KEY SHARE SKIP LOCKED (the server keeps a channel) and the
   durable tombstone (`cleanupState = 'pending'`). The channel row is **not**
   deleted here: its FK cascades (`channel_read_positions`, `server_events`;
   before migration 088 also `message_reports`) are unbounded and used to run
   inside the claim. From this
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
   find nothing — and marks the tombstone `converged` (the DATABASE graph has
   converged; objects have their own lifecycle below). Every step is
   idempotent and durable, so crashes, retries and concurrent nodes are safe.
3. **Objects (migration 089)** — deleting stored bytes cannot be atomic with
   PostgreSQL, so the cleanup records the upload URLs of the rows it deletes
   (`messages.fileUrl`, `voice_messages.url`, podcast audio/cover/legacy file
   name; never `messages.avatarUrl`, a shared author avatar) in
   `channel_object_release_outbox` **in the same statement** as the delete. A
   separate post-commit phase leases due rows (attempts + 1, lease 5 min,
   FOR UPDATE SKIP LOCKED) and asks `lib/channelObjectRelease.ts` to delete each:
   - only exact Bridge locations are deleted: `/uploads/<file>` in the PRIVATE
     storage (local disk, S3, R2, MinIO, B2) and the persistent assets
     `lib/uploadRelease.ts` recognises (e.g. `/uploads/recordings/<file>`);
     anything else (an external URL, a path with `..`, a subdirectory Bridge
     does not own) is `retained` as `unrecognized` — an external URL's
     basename is never mapped onto a local file;
   - `hasLiveUploadReference` re-checks every upload column first; a file still
     used elsewhere (a crosspost) is `retained` as `still_referenced`; the check
     is fail-closed (no PostgreSQL → error → retry, never delete);
   - errors retry with backoff (30 s doubling, max 6 h) and become `failed`
     after 8 attempts (logged as `channel.expiry.objects_failed`, kept for an
     operator); a crash between the delete and the state update lets the lease
     expire and the retry finds the object absent (idempotent);
   - a finished row is reopened if another row of the same channel queues the
     same URL later (it may have been retained only because that row still
     pointed at it);
   - `released`/`retained` history is pruned after 30 days; `failed` stays.
   The daily `cleanupUploads` sweep remains the reconciliation backstop for
   root-level attachments.

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
row is deleted while the audit row and all 4 reports survive. Rollback gate: 087 lossless; isolated 084
reversal is a declared `EXPECTED_DEPENDENCY` on 087.

## Owner decisions / not built

- **Last live channel:** never claimed. Whether such a channel may expire
  (refused at configuration time, or replaced by a fresh default channel)
  is a product decision for the expiry API.
- **Moderation evidence (owner decision, migration 088):** an expired
  channel's `message_reports` and their 085 evidence snapshots are retained, as
  are security `audit_logs`. See `docs/P7_D2_REPORT_RETENTION.md`.
- Not built: federation tombstone propagation. Ordinary (non-expiry) channel
  deletion still relies on the daily sweep for root attachments and does not
  use the object outbox.

## Object release evidence

- `channel-object-release.pgtest.ts` (real PostgreSQL + real local storage, 6
  cases): attachment, voice message, podcast recording and legacy file name
  released; a crossposted file and an external URL whose basename matches a
  local file retained; a bounded pass queues exactly what it deleted and
  nothing is touched before the post-commit phase; 8 failing attempts with
  growing backoff end in `failed` and the object survives; two concurrent nodes
  release each of 6 objects once; a lease that expires after a crash finishes
  idempotently; a retained duplicate is reopened and released; 089's down
  refuses while objects are pending. Negative controls run locally: without URL
  capture 6/6 fail, without reopening 1/6, without the reference check 2/6.
- `channel-object-release-s3.pgtest.ts` (S3-compatible private bucket; CI's
  MinIO-compatible service, locally moto): the expired channel's object is
  deleted, the one still referenced from a live channel stays.
- `channel-object-release.test.ts`: location rules and the state machine.
- Rollback gate: 089 lossless; ordered chain 0 lost / 0 extra.
