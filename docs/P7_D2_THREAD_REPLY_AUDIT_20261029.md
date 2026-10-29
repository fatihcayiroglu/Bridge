# D2 thread reply and nonce-response boundary

Child of #581 `e7c5e386e3d795197e87c347a69e438cde33f78b`; retains #578/#576
and #574. P7/#321 remain OPEN. No production merge, deployment or B1 change.

`POST /api/threads/:threadId/messages` previously checked membership/permissions
and content but no canonical channel expiry. An authenticated stale client could
also receive a previously stored nonce response after its channel expired.

Use `channelWriteAvailability` with a freshly loaded tenant-bound channel after
existing authorization, before returning a stored nonce row and after actual
content verification before insertion. Gone returns 404; unverifiable canonical
state returns 503. Existing stored replies are retained. Permanent/live channels
and canonical nonce idempotency remain intact. No permission, auth or assertion
is weakened; no direct client publication is allowed.

This is preflight, not a transaction fence. Expiry can still race insertion,
the repository's internal conflict reread, counters or publication. Forum/parent
thread creation, separate history/read/join paths and administrative mutations
are not qualified by this change. Erasure/cleanup policy is not chosen here.

Five new unit cases cover expired creation, expired nonce replay without content
disclosure, expiry during actual nonce lookup, expiry during actual content
verification and unverifiable authority. Local four thread suites: **109/109
PASS**, zero failed/skipped. Controlled interleavings execute the real lookup
and content policy before changing the fixture state; they do not fake success.

The PG16/Redis suite adds three actual authenticated HTTP cases (production auth
middleware + signed fixture JWT): six concurrent submissions of one nonce store
and publish once, expiry blocks stored/new nonce requests while retaining the one
row, and SQL expiry after actual content verification prevents insertion. The
concurrent submissions use distinct text to avoid conflating idempotency with
the separate repeated-content policy; all receive the canonical winning row as
the existing thread API specifies. This is not the native outbox ackId protocol
or a cross-account/reinstall/native-device claim.

The inherited dedicated workflow now runs the 140 scheduling/voice unit tests,
109 thread unit tests and 11 real PostgreSQL16/Redis tests, each with zero-skips
enforcement. New exact-head CI is pending at preparation; the parent's 140/8
passes are not copied onto this new implementation.
