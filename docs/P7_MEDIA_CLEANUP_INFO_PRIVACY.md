# Routine media cleanup INFO privacy

The voice-node correction in #434 did not cover the surrounding cleanup
coordinator or expiry timer. Capturing actual production Pino serialization
through the real PostgreSQL/Redis/Socket.IO expiry journey exposed user,
socket, server and channel identifiers in those routine INFO records. The
baseline had 26 passing media tests and one failing privacy assertion, zero skips.

`logRoutineMediaInfo` now owns the five routine eviction/publishing event
names and their messages. It rebuilds each payload from an allowlist of event,
boolean SFU presence and nonnegative safe integer room/producer counts. It
does not forward structural extras, DTO serializers or caller messages.
Malformed counts are omitted rather than represented as a false zero.

Only the synchronous INFO emission enters a correlation-only request scope.
Authorization, permission memoization, media teardown and security WARN/ERROR
records retain their original context. Background timers without a request
scope do not invent correlation; scoped timers retain their request ID without
inheriting actor identity. The helper reuses the existing AsyncLocalStorage
implementation and replaces #434's narrower private helper.

## Validation

- 107 focused unit tests passed, zero skips, including actual serialized Pino
  records, structural extras, getters, malformed counts, all voice revocation
  paths, concurrent request scopes, background work and a throwing log sink.
- 28 real PostgreSQL/Redis/Socket.IO media tests passed, zero skips. The
  existing expiry-instant timing, two-participant notification, roster and room
  assertions remain. Added checks cover the complete coordinator/timer log
  path and a separately armed request-scoped timer with inherited private
  context. The database and logger are real; no expiry worker is running.
- Production types, strict test types, hardening types and server lint passed.

Full source-head CI is required separately. This change covers these five
routine event types only; it does not establish complete metadata minimization,
real SFU media acceptance or closure of P7 B3, #321, #209 or #416. The branch
is stacked on #434 and does not authorize a production merge.
