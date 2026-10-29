# P7 D2 incoming webhook expiry boundary

Base: #590 `fa84d599a93cc60534d97d99f1c173de79df3698`, preserving its history
and the older integration drafts. P7 and #321 remain OPEN. No main merge,
deployment, Android source or Abuse Lab change.

The incoming bearer-webhook route could insert and publish into an expired or
tombstoned channel. Valid credentials remained valid after channel expiry, and
target moderation/cache invalidation introduced additional asynchronous windows.
New tests before correction: **3 PASS / 5 FAIL / 0 skipped** in unit controls;
**4 PASS / 6 FAIL / 0 skipped** through the actual HTTP route on PostgreSQL/Redis.
First failure evidence is preserved.

After existing constant-time credential validation and tenant checks, reuse the
canonical `channelWriteAvailability` query for live SQL row, tenant, tombstone
and database time. Refuse expired/gone authority with 404, unverifiable authority
with 503, using fixed error copy. Check before moderation, after moderation and
through #590's shared publisher after cache invalidation, before both live events.
The route also refuses HTTP success when that final check refuses publication.
Existing machine-principal AutoMod, embed limits and token semantics remain.

If expiry follows the committed insert, keep the row for later durable cleanup
and refuse publication/success. This does not make commit and expiry atomic;
it does not add webhook idempotency. A transient failure after insertion may
still produce a duplicate on a later successful retry. No external object write
or deletion is added, and no newly enabled expiry endpoint is claimed.

Local verification: **101 unit tests PASS**, including eight new webhook cases
and existing bot/moderation/publication controls; **34 actual PostgreSQL 18/Redis
tests PASS**, including ten new webhook HTTP cases and the existing 24 D2 cases.
All have zero failed/skipped tests. Cases cover permanent/live-expiring controls,
expired SQL despite a stale permanent DTO, durable tombstones, moderation,
committed insertion, actual Redis invalidation, tenant mismatch and bad tokens.
The socket emitter is observed; no full application/browser/Socket.IO E2E or
multi-node authentication acceptance is inferred.

The existing mandatory focused workflow retains PostgreSQL 16/Redis and its
zero-skips checks, adding the new unit/HTTP integration files. Exact-head CI is
required independently of the local PostgreSQL 18 run and parent #590 evidence.
Release-integrity **223 PASS**, zero failed/skipped, without changing assertions.
Production/strict types and build must pass before push. No dependency graph
change; the parent four patched lock graphs are retained.

Open boundaries include the corrected older database write barrier/integration
sequence, full writer/reader/room graph, cleanup and crash recovery, object outbox,
offline/federation convergence, activation policy and representative performance.
This repeated preflight does not replace the existing corrected #362/#375 work.
