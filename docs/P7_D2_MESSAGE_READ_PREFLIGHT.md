# P7 D2: authoritative channel message read preflight

**Scope:** The routes in server/routes/messages.ts now validate the channel
against a live PostgreSQL row and the durable expiry tombstone on every
channel-content access, even when channel metadata and first-page messages
are cached. This is one production-reachable **read preflight**, not D2 closure.

- Tenant identity, expiresAt, expiryVersion, tombstone existence and current
  database clock are read in one indexed statement.
- Existing permanent channels (expiresAt NULL, expiryVersion 0) remain readable
  to appropriately authorized members.
- Missing, expired, tombstoned or invalid channel state returns 404 without
  cached content. Database failure returns 503, never a cache fallback.
- Existing membership and VIEW_CHANNELS/READ_HISTORY checks still apply.
- On test-only mock databases without PostgreSQL, use the existing pure D2
  validator for legacy/permanent channels. Production requires a real PG pool.
- The HTTP suite verifies an actual first-page cache population followed by
  a direct PostgreSQL expiry update, and checks pinned/history against a
  tombstone. The unit suite covers tenant, clock, version and error states.

## Explicit limitations

This read check is **not transaction-scoped** around later content retrieval.
The channel could expire after the preflight but before sending a response.
It also does not cover other API/socket read paths, writes, threading, offline
caches or federation. It does not publish expiry and does not start a worker.
The expiry/tombstone write path must take appropriate row locks and enforce
a complete durable state machine before enabling ephemeral channel creation.
There is a per-request indexed PostgreSQL read overhead; measure performance
and keep or refine the authorization strategy before a feature rollout.

Related: P7 D2 issue #321, pending #348/#349 and experimental #351.
Do not report D2 complete until the full issue's end-to-end acceptance gates
and final-main tests pass.
