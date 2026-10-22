# P7 D2: expired-channel graph cleanup and scheduled-send terminal refusal

This is a **stacked draft** based on #360 → #358 → #357 → #356.
It does not enable the public ephemeral-channel feature on `main`.

## Channel cleanup rules

The expiry worker claims with FOR UPDATE SKIP LOCKED and writes only the
tombstone; the channel row is deleted by the last cleanup pass, after every
FK-referencing table is drained (see `P7_D2_CHANNEL_EXPIRY_WORKER.md`).

- **Keep `audit_logs`**. Channel deletion must not destroy security or
  administrative history. The `channelId` in an audit record is retained as
  historical evidence; it is not a live channel reference.
- **Bounded reply deletion before thread deletion.** A thread reply is
  reachable by `threadId` even when its stored `channelId` disagrees with
  the parent. Each pass deletes up to `batchSize` matching replies and
  separately sweeps direct channel-owned replies. A thread is only deleted
  after no reply with its `threadId` remains. A crash between passes cannot
  strand linked replies behind a deleted parent.
- **Unlink stale server settings.** Clearing a channel also NULLs matching
  `servers.logChannelId` and `servers.verificationChannelId`, plus
  `server_onboarding.rulesChannelId` and `welcomeChannelId`, scoped to
  the tombstone's server ID. Presence of these optional columns is checked
  on the active schema. Do **not** silently disable verification or
  onboarding policy flags.
- **Other channel-owned rows** still use bounded deletion with the existing
  retention limitations. Tombstones remain durable and are marked converged
  only after a pass finds nothing left to delete. Ordinary audit records
  intentionally do not count as channel-owned content.

## Scheduled messages

PostgreSQL error SQLSTATE `BX001` is the definitive channel write barrier
denial; a scheduled dispatch gets terminal failure reason
`channel_unavailable` rather than exponential retry. Other database
errors, including SQLSTATE `40001`, keep the bounded backoff policy.
A failed attempt to persist the terminal state is logged, and does not abort
the other claimed schedules.

## Verification targets

- `channel-expiry-worker.pgtest.ts`: three foreign-`channelId` replies
  linked to a doomed parent; one-row cleanup batch leaves the parent until
  the remaining replies are gone; retains an audit event; unlinks four
  config pointers; keeps a sibling channel.
- `jobs-scheduledMessages.test.ts`: SQLSTATE `BX001` fails on attempt 1
  without lease retry; SQLSTATE `40001` still retries.

Do not treat authored tests as **passed** until exact-head CI and the real
PostgreSQL suite execute. Resolved in the follow-up to this PR: the
migration-085 conflict with B5 #345, the unbounded FK cascade inside the
initial claim and the write-barrier update exception. Still open: B5 evidence
retention beyond expiry (owner decision), notification delivery and
offline/federation convergence.
