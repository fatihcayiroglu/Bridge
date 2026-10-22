# P7 D2 × B5 — moderation reports outlive their channel

**Owner decision (2026-10-22, issue #321):** expiring or deleting a channel must
not destroy its moderation reports or the evidence captured for them. The
policy builds on B5's evidence-safe reports (#345, migration 085).

## What changed

| | Before | Now |
|---|---|---|
| `message_reports."channelId"` | FK to `channels`, `ON DELETE CASCADE` | no FK (migration 088); keeps the id the report was filed in |
| Channel expiry cleanup | deleted the channel's reports | keeps them (`RETAINED_TABLES` in `lib/channelExpiryWorker.ts`) |
| Owner deletes a channel (`deleteGraphAtomic`) | deleted the channel's reports | keeps them |
| Moderation queue for a gone channel | report hidden (`if (!channel) continue`) | shown with `channel: { name: null, available: false }` and the report-time evidence only |

Unchanged: `serverId` FK `ON DELETE CASCADE` (deleting a server deletes its
reports and audit history — tenant ownership), `reporterId` CASCADE,
`resolvedBy` SET NULL, 085's author-erasure trigger, all indexes.

## Retention

- **Open report:** the evidence snapshot is kept.
- **Resolved or dismissed:** kept for `MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS`
  (default 90, 1–3650), then `jobs/reportEvidenceRetention.ts` clears every
  evidence content column and records `evidenceScrubbedAt` (the lifecycle CHECK
  refuses a partial scrub).
- **Minimal metadata kept after the scrub:** ids (report, server, channel,
  message, reporter, resolver), reason, the reporter's note, status, resolution
  and timestamps.
- **Security `audit_logs`:** never deleted by expiry or channel deletion; they
  go with the server.

## What is never retained for a report

The expiry worker and ordinary deletion still remove the conversation. A report
keeps only 085's bounded snapshot: at most 4000 characters of stored text, the
author id and display name, message type, created/edited times, attachment file
name and type. **Never:** other messages, attachment bytes, object URLs, embeds,
reply quotes or E2EE ciphertext (an `e2ee` message is captured with empty text).

## Access

- While the channel is live, the moderator's permissions **in that channel**
  decide, overrides included. The moderator needs `VIEW_CHANNELS` and
  `MANAGE_MESSAGES` there, or `ADMIN`. A moderator who cannot see a channel
  cannot moderate its reports.
- Once the channel is deleted, expired (even before the worker claims it) or
  tombstoned, only **`ADMIN`** (the owner included) decides. The channel's
  overrides go with it, so nothing records whether a server-level moderator
  could see it. A private channel's evidence would otherwise reach moderators
  it had hidden from them, and a deleted channel would widen access.
  Administrators could see every channel anyway.
- Liveness is read from PostgreSQL (row, tenant, tombstone, database clock:
  `channelLiveForMessageRead`).
- Follow-up: a finer rule needs a schema change, so it is not done here. At
  deletion or claim time, record on the channel's reports whether the channel
  restricted `VIEW_CHANNELS`. Server-level moderators could then keep access
  to reports from public channels.
- Rows of an expired channel that the worker has not drained yet are never
  shown; the queue shows only the snapshot.
- Reports are always read by `(serverId, reportId)`: another server's owner
  cannot list or resolve them (404 through their server, 403 through this one).

## Conflicts with deletion requests (documented, not hidden)

1. **Author erasure.** The snapshot's author id and name are anonymized in the
   same transaction (`deleted-user`, empty name) on every node, old or new. The
   reported **text stays** until the report's retention ends — the same as the
   author's messages themselves, which account erasure anonymizes but keeps. A
   deletion request does not erase evidence of a report under review; it does
   bound it (open report + 90 days after resolution).
2. **Ephemeral expiry.** A user who posts in an ephemeral channel can expect
   the content to vanish. A reported message's snapshot outlives the channel by
   design; the client should say so where expiry is configured (product copy,
   not yet written).
3. **Reporter erasure.** `reporterId` is still `ON DELETE CASCADE`: erasing the
   reporter's account deletes their reports and the evidence with them. This is
   existing behaviour, kept unchanged here; keeping such reports would need its
   own owner decision (reporter anonymization instead of deletion).
4. **Server deletion** removes the server's reports and audit history.

## Migration 088

- Up: `ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS "message_reports_channelId_fkey"`.
  Online-safe: dropping an FK takes a brief `ACCESS EXCLUSIVE` lock and rewrites nothing.
- Down: locks `channels` then `message_reports` and **refuses** while any report
  points at a missing channel (restoring the CASCADE key would require deleting
  those reports and their evidence); otherwise re-adds the original key.
- Rollback gate: 088 is `LOSSLESS_PASS`; 063's isolated re-up now also recreates
  this key (declared in `rollback-classification.json`); the ordered chain
  measures 0 lost / 0 extra.
- Equivalence (local, PostgreSQL 16): a fresh install equals, by `pg_dump -s`,
  an upgrade from current `main` (with a seeded report that survives), from the
  D2 stack without 085 (085 then applied after 087) and from #345's branch.

## Evidence

`server/tests/pg-integration/report-retention.pgtest.ts` (real PostgreSQL, 9
cases): schema; expiry keeps open and resolved reports with evidence while the
conversation is removed; channel deletion keeps reports and server deletion
removes them; an administrator sees and resolves a gone channel's report, while
a server-level moderator, the channel-override moderator, a plain member and
another server's owner cannot; a private channel hidden from the moderator role
stays hidden from it while live, expired-unclaimed and after the worker drained
its overrides (both cases fail under the previous server-level rule); an expired-but-unclaimed channel's edited row is never shown; the
retention worker scrubs at 91 days, keeps 89 days and open reports; author
erasure anonymizes and reporter erasure removes; 088 down refuses. Negative
controls (each run locally): with the FK restored 7/8 fail; with the worker
draining reports 3/8 fail; with #345's route logic 2/8 fail.
Client: `moderation-tab.test.ts` renders a gone channel as
`moderation_report_channel_gone` with no jump.
