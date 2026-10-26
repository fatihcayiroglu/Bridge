# Routine voice INFO metadata minimization

Removing explicit user and channel fields from voice revocation logs was
insufficient: Pino's production request-context mixin added the current actor's
user and socket identifiers back during serialization. Logger-call mocks did
not observe that boundary.

The three routine voice eviction/publishing INFO emissions now execute inside
a synchronous correlation-only request scope. They retain the existing event,
request ID, SFU boolean and producer count. Authorization, roster changes,
Socket.IO notifications and producer cleanup still execute in the original
request scope. The actor, socket and permission memo are restored immediately
after logging, including when a logging sink throws. Other log levels and
security/audit records retain their existing context.

The change reuses the existing AsyncLocalStorage request-context implementation
and the earlier local explicit-payload scrub. It does not change the global
logger, permission checks, retention policy, database schema or mobile code.

## Executable evidence

Tests capture actual Pino records at its destination **after** the production
mixin and serializers. The logger and request-context implementation are real.
The isolated unit tests stub media operations; they do not claim real SFU media.

- Before the context fix: 2 of 7 new unit cases passed and 5 failed on serialized
  actor identity. All four P2P/SFU access/speak paths and concurrent requests are
  covered, with background and throwing-sink controls.
- Before the fix with real PostgreSQL, Redis and Socket.IO: the existing 26
  media cases passed and the new serialized-log privacy case failed, zero skips.
- After the fix: 67 focused context/permission/voice unit tests and all 27 real
  PostgreSQL/Redis media tests passed, zero skips. The integration case proves
  the selected user leaves the actual roster while another participant stays,
  routine INFO contains correlation without identities, and a security WARN
  retains the caller's actor and socket context.
- Production types, strict test types, hardening types and server lint passed.

These results establish this specific metadata correction. They do not close
P7 B3, channel-expiry issue #321, physical-device acceptance or other open P7
requirements. The draft change is based on current #423 (`5ba6006d`); it does
not authorize production integration. Fresh source-head CI is still required.
