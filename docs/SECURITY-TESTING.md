# SECURITY TESTING — Bridge v1.123

**This document does not claim a penetration test was performed.** No human pentest
has been conducted. What follows is the attack surface, the controls that exist, and
what a human tester should attack — written so that an external tester can start
without reading the codebase first.

---

## 1. Trust boundaries

| Boundary | Untrusted input | Control |
|---|---|---|
| Browser → HTTP API | Everything: body, query, headers, cookies | Schema validation, auth middleware, CSRF, rate limiting |
| Browser → Socket.IO | Event names and payloads | Socket auth middleware, per-event validation, per-IP/user connection limits |
| Reverse proxy → app | `X-Forwarded-For` | **Only trusted when `TRUSTED_PROXY_COUNT` is set.** Unset ⇒ header ignored entirely |
| App → PostgreSQL | Column identifiers | `ALLOWED_COLUMNS` allowlist (identifiers cannot be bind parameters); values always parameterised |
| App → Redis | Keys derived from user data | Namespaced keys |
| Federation peer → app | ActivityPub payloads, HTTP signatures | Signature verification, per-peer keys, inbox rate limits, allow/block lists |
| Uploads | File content, names, MIME | Type/size checks, generated storage names, ownership checks on serve |
| External providers (OIDC/SAML/SMTP/TURN/S3) | Provider responses | Configured issuers/origins |

## 2. Authentication and session model

- Access tokens: JWT signed with `JWT_SECRET` (≥ 32 chars, enforced at startup)
- Refresh tokens: httpOnly cookie, signed with `REFRESH_SECRET`, reuse detection
- **Token claims carry no authority.** `isAdmin` is read from the database on every
  privileged request — a forged claim grants nothing (`middleware/auth.ts`)
- `tokenVersion` allows global invalidation
- WebAuthn/passkeys with strict origin validation (hardened in v1.122.0)
- 2FA available

## 3. Authorisation model

- Server membership required for server-scoped reads
- Channel-level permission overrides resolved per request
- Role hierarchy requires **strict** positional superiority; the owner is unbounded.
  (v1.122.0 fixed delegation being inert for everyone except the owner.)
- Fail-closed: unresolved permission ⇒ denied

## 4. What to attack (priority order for a human tester)

1. **Cross-tenant access.** Can user A read a channel, message, upload, poll, thread,
   invite or Soundboard item belonging to a server they are not a member of? Try
   direct object references with valid IDs from another tenant.
2. **Permission escalation via role positions.** Can a user assign or edit a role at
   or above their own position? Can they act on a member with an equal position?
3. **`X-Forwarded-For` spoofing.** With `TRUSTED_PROXY_COUNT` misconfigured, can a
   client forge its IP to escape rate limits or IP bans? This exact class was found
   and closed in the WebSocket connection limiter — check for further siblings.
4. **CSRF.** Mutating routes require `X-CSRF-Token`; the token is bound to the
   session. Try cross-origin mutations and token reuse across accounts.
5. **Upload handling.** Type confusion, path traversal in filenames, serving another
   user's file, access to a deleted message's attachment (there is an explicit test
   for the last one — try to break it).
6. **Socket authorisation.** Can an authenticated socket join a room it has no
   membership for, or receive fan-out for a channel it cannot view?
7. **Federation.** Signature bypass, replay, key confusion between peers, SSRF via
   actor/object URLs.
8. **Rate limit and ban evasion**, and its inverse: can one user get an entire shared
   IP banned? (See §6.)
9. **Information leak via error messages** — see §5.
10. **Unread/notification endpoints** — these resolve permissions per channel; check
    that a revoked viewer stops seeing counts immediately.

## 5. Error-handling expectations

No user-facing response should contain a stack trace, SQL text, internal file path or
raw parser exception. The cross-browser suite asserts this for unauthenticated
rejections; a tester should push much harder (malformed JSON, oversized payloads,
unexpected content types, unicode edge cases).

## 6. Known weaknesses — disclosed deliberately

| Weakness | Detail |
|---|---|
| **Shared-IP limits** | `MAX_WS_PER_IP = 10` (measured: exactly 10 sockets per IP, 11th refused). A whole NAT shares that budget. Connection-rate limits can also block a whole IP. This is a **denial-of-service-against-legitimate-users** surface, not a bypass. |
| **Redis fail-closed** | When Redis is unreachable every request is rejected `503`, including `/api/health`. Deliberate, but it means Redis availability is a hard dependency for service availability. |
| **Firefox service-worker reload defect** | Reload hangs / blank page. A correctness and availability issue for Firefox users; no known security impact. |
| **Plugin admin API absent** | Plugin load/unload executes arbitrary code but has no HTTP surface at all — nothing to attack today, and nothing to review either. |
| **No alerting** | Detection depends on humans. An attacker has time. |

## 7. Automated coverage that already exists

The server suite (8,262 tests) includes dedicated security regressions for: WebAuthn
origin handling, role hierarchy/delegation, `X-Forwarded-For` handling in both HTTP
and WebSocket limiters, `pgCollection` injection and the column allowlist, CSRF,
IP reputation and ban authority, federation key load/rotation, auth input boundaries,
file/attachment authorisation, and rate-limit fail-closed behaviour.

Passing these means known regressions are covered. It does **not** mean the system is
secure — that requires the human testing described above.

## 8. Rules of engagement for a tester

- Test against a **disposable staging instance**, never production
- Do not attempt destructive DoS against shared infrastructure
- Report cross-tenant access, auth bypass and data loss immediately; do not continue
  exploiting
- Bring the `X-Request-Id` from any interesting response — it locates the exact
  server-side request in the logs
