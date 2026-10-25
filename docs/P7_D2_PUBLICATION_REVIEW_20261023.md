# D2 publication after commit — 2026-10-23

The expiry INSERT barrier protects persistence. It cannot authorize a later
publication of a row already held in memory. The cleanup worker and live-room
eviction may not have run when a deferred sender resumes.

## Reproduced defects

Against the real PostgreSQL production adapter, the original shared publisher
emitted both message content and the activity signal after expiry. Both the
cache-invalidating publisher and direct broadcaster leaked. A tombstone also
failed to stop a detached row from being broadcast. Three negative cases failed
while permanent and future-channel controls passed.

A separate real PostgreSQL interleaving expires the channel after asynchronous
bot discovery. The original bot dispatcher still sent private slash-command
arguments to the registered bot. That denial assertion failed while the live
registered-command control passed. No cleanup worker or mocked lifecycle decision
is involved in these regressions.

## Correction

- The shared broadcaster awaits the existing authoritative `liveChannelSet`
  guard after cache invalidation, immediately before synchronous emits. It
  checks the tenant, database clock, persisted row and durable tombstone.
  Missing or expired channels return false; database uncertainty throws without
  emitting. A caller without Socket.IO still gets an availability decision.
- The normal socket sender uses this publisher. Its minimal ACK is sent for a
  committed row even when publication is denied or its preflight fails. A denied
  publication returns before bot, webhook, plugin, notification and bridge fan-out.
- Bot command delivery rechecks after discovery; bot interaction HTTP replies
  await the broadcaster and answer 404 or 503 without returning detached content.
- A link preview that completes later rechecks availability before its socket
  update. This retains the existing PostgreSQL write barrier on its UPDATE.

This adds no competing expiry implementation, schema change, client timestamp
authority, audit exemption or test skip. Permission checks at admission remain
required; the lifecycle guard is not a permission grant. The preflight is an
authorization decision before delivery, not a guarantee that previously sent
network bytes can be recalled after expiration.

## Validation

- Ten PostgreSQL publication regressions pass: permanent/future channels, expired
  detached rows, tombstones, forged tenant, deleted channel without Socket.IO,
  the production socket handler interrupted after a real COMMIT, deferred bot
  discovery, and live registered-bot delivery.
- The complete PostgreSQL/Redis/S3 suite passes 352 tests with zero skips.
- Focused units cover invalidation/check/emit order, database failures, minimal
  ACK preservation, delayed link previews, and HTTP denial without content.
- Strict production types pass. The strict test ratchet passes without adding
  debt after explicitly narrowing the fixture's persisted plaintext content.

Full coverage and exact-commit GitHub checks must be recorded on the review PR.
The outstanding iOS journey, human review and final integration checks remain
requirements in `P7_D2_INTEGRATION_PLAN.md`; neither this follow-up nor a previous
green branch closes issue #321 or P7.
