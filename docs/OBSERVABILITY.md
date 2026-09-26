# OBSERVABILITY — Bridge v1.123

Every claim in this document is labelled:

- **[EXECUTED + VERIFIED]** — implemented in this tree and demonstrated by a test or
  a live measurement recorded here.
- **[SHIPPED, NOT LOAD-VALIDATED]** — the code exists and works, but has not been
  exercised under production-like traffic.
- **[DOCUMENTED FOR PRODUCTION EXECUTION]** — a procedure for real operators; not
  performed here.

There is no production deployment of Bridge behind this document, so **no uptime,
latency or availability figure here is a production observation.** Where numbers
appear, they are from a local disposable environment and are labelled as such.

---

## 1. Request correlation **[EXECUTED + VERIFIED]**

### The gap

Before v1.123 there was **no correlation identifier anywhere in the server**. Logs
recorded *what* happened but never *which request* it belonged to. During an
incident the first question — "what did the request that 500'd actually do?" —
could not be answered, because a single user action produces log lines from the
route, the repository layer, Redis, and any external provider, with nothing tying
them together.

### The implementation

| File | Role |
|---|---|
| `server/lib/requestContext.ts` | `AsyncLocalStorage` store; id generation; inbound-header adoption; pino `mixin` |
| `server/middleware/requestId.ts` | Mounted first in the chain; issues/adopts the id and echoes `X-Request-Id` |
| `server/lib/logger.ts` | `mixin: requestContextMixin` in `pinoOptions` |
| `server/app/createApp.ts` | `app.use(requestIdMiddleware)` **before** `securityHeaders` |
| `server/middleware/auth.ts` | `attachActor(decoded.id)` after token verification |

**Call sites did not change.** The correlation id rides on pino's `mixin`, so the
several hundred existing `logger.warn({ event })` calls started carrying
`requestId` without a single line being edited. This was deliberate: threading a
parameter through manually would have altered hundreds of signatures and would break
silently at the first place someone forgot.

The middleware is mounted **before** `securityHeaders` so that early-returning
middleware — rate limit, CSRF, IP ban — still emit correlated logs. Those are
exactly the rejections an operator most needs to trace.

`X-Request-Id` is echoed on the response so a user reporting "I just got an error"
yields one value from their browser's network tab that locates the exact server-side
request.

### Inbound header handling — conditional trust

A reverse proxy usually generates its own `X-Request-Id` and writes it to its access
log; adopting it makes proxy and application logs joinable. But the header can also
come from a client, and client input is untrusted:

| Hostile input | Consequence if trusted | Behaviour |
|---|---|---|
| Unbounded length | log bloat | rejected, fresh id issued |
| Control characters (CRLF) | forged log lines (log injection) | rejected |
| A fixed constant | every user's events merge under one id | rejected (format `[A-Za-z0-9_-]{8,128}`) |
| Repeated header (array) | ambiguous — picking one is a silent guess | rejected |

A bad header is **never** grounds for rejecting the request. Traceability is not a
security boundary, and dropping legitimate traffic over a malformed header would be
the wrong trade.

### Evidence

`server/tests/request-correlation.test.ts` — **21 tests, all passing (3.4 s)**:

- an id is issued, echoed on the response, and identical to what the handler observes
- a different id per request
- a well-formed proxy id is adopted
- five hostile header shapes are refused over real HTTP without the request failing
- CRLF injection is refused (see note below)
- the context survives `await`, `Promise.all` branches, and timer callbacks
- two concurrent requests never observe each other's id
- no correlation fields are emitted outside a request, so startup logs stay clean
- `attachActor` adds `userId` mid-request without opening a new context
- a real pino instance using the **production** `mixin` stamps `requestId`/`userId`
  onto ordinary `logger.warn({ event })` calls

Two measured facts shaped that suite, both worth recording:

1. **CRLF cannot be tested over HTTP.** Node's own `setHeader` rejects control
   characters before the header reaches Express — so the transport layer is the
   first defence and `adoptRequestId` is the second. The test asserts the second
   directly rather than pretending to exercise the first.
2. **supertest leaks a TCP server per call.** Calling `request(app)` per test left
   `TCPSERVERWRAP` handles open and the suite hung past 600 s producing *no output
   at all*. The suite now opens one `app.listen(0)` in `beforeAll` and closes it in
   `afterAll`. Recorded because the symptom (silence) points away from the cause.

### Not done

Socket.IO events do not yet open a correlation context. `attachActor` already accepts
a `socketId`, so the hook exists; wiring the socket handlers is follow-up work.

---

## 2. Metrics **[SHIPPED, NOT LOAD-VALIDATED]**

`server/middleware/metrics.ts` exposes Prometheus metrics on `/metrics`.

> **Final21 Phase 9 correction.** This table previously said "verified live",
> but that check only confirmed the metric *names* existed. A name existing is
> not the same as the metric carrying data. Measured against the running server
> under real traffic and real dependency outages, several series were empty or
> fake, and 9 of 23 alert rules could never fire (see F21-9-01 in the evidence
> log). The "Fed by" column below is what was verified after the fixes.

| Metric | Type | Fed by (verified) |
|---|---|---|
| `bridge_http_request_duration_seconds` | histogram | HTTP middleware |
| `bridge_http_requests_total` | counter | HTTP middleware |
| `bridge_http_errors_total` | counter | HTTP middleware (status ≥ 400) |
| `bridge_websocket_connections` | gauge | engine client count, read at scrape (was never set before Final21) |
| `bridge_websocket_events_total` | counter | **not fed** — `trackWsEvent` has no product call sites; do not alert on it |
| `bridge_db_query_duration_seconds` | histogram | PostgreSQL client instrumentation, labels `operation`, `collection` (was never observed before Final21) |
| `bridge_db_queries_total` | counter | same; failures counted as `operation="<op>_err"` |
| `bridge_db_up` | gauge | background `SELECT 1` probe every 10 s, 3 s timeout; scrape only reads the result (was a constant 1 before Final21 — stayed 1 during a 32 s outage) |
| `bridge_redis_up` | gauge | Redis adapter availability (verified to drop to 0 during an outage) |
| `bridge_active_users` | gauge | socket user map, read at scrape |
| `bridge_active_sockets` | gauge | socket user map, read at scrape |
| `bridge_voice_rooms` | gauge | canonical Redis-aware room count, 10 s cache (was always 0 with Redis before Final21) |
| `bridge_rate_limit_hits_total` | counter | rate limiter; series appears after the first 429 |
| `bridge_auto_ban_total` | counter | auto-ban path; series appears after the first ban |
| `bridge_rate_limit_anomaly_score` | gauge | anomaly detector; 0 below 20 hits in 5 min (a single 429 used to score 3) |

Default `process_*` / `nodejs_*` collectors are enabled under the `bridge_` prefix,
so alert rules must use the prefixed names (e.g. `bridge_process_resident_memory_bytes`).
`server/tests/alert-rules-metric-contract.test.ts` fails if any rule queries a
metric or label the server does not register.

**Cardinality** is already guarded by tests
(`tests/metrics-cardinality.test.ts`) — route labels are templated, not raw paths,
which is the usual source of unbounded label growth. Endpoint exposure is gated
(`tests/metrics-endpoint-gating.test.ts`).

**What is missing:** these counters have never been observed under real traffic, so
no baseline exists for any of them. Alert thresholds derived from them today would
be guesses.

---

## 3. Logging hygiene

`pino` structured JSON, one event per line, with `service` and `env` on every record
and now `requestId`/`userId` where a request context exists.

Secrets are not logged: passwords, access/refresh tokens, CSRF secrets, private keys,
WebAuthn material, and provider secrets do not appear in log statements. The
correlation work did not add any new field carrying user content — `requestId`,
`userId`, `socketId` only.

---

## 4. Health and readiness **[SHIPPED]**

`GET /api/health` returns `{status, version, uptime, ts, db}` and was used throughout
this pass as the readiness gate for the E2E web server
(`e2e/playwright.config.ts` polls it before running).

`tests/health-operational-states.test.ts` covers the operational-state semantics.

---

## 5. SLIs and SLOs **[DOCUMENTED FOR PRODUCTION EXECUTION]**

The metrics above are sufficient to define these SLIs:

| SLI | Derived from |
|---|---|
| HTTP availability | `bridge_http_errors_total` ÷ `bridge_http_requests_total` |
| HTTP latency | `bridge_http_request_duration_seconds` |
| WebSocket connection health | `bridge_websocket_connections`, disconnect events |
| DB latency | `bridge_db_query_duration_seconds` |

**No SLO is stated here as met.** There is no production data, so any target would
be an aspiration rather than a measurement. Targets must be set only after a
baseline period on real traffic; this document deliberately records **TARGET: not
yet set / MEASURED: no production data** rather than inventing numbers.

One local, non-production measurement worth carrying into that exercise, because it
is a real scaling defect that was found and fixed here:

### `GET /api/notification-prefs/unread` — measured N+1 **[EXECUTED + VERIFIED]**

App-open path. Resolved permissions *and* read a mute preference **per channel**, up
to the `UNREAD_MAX_CHANNELS = 200` cap. Measured on real PostgreSQL, p50 of 7
samples, identical channel counts before and after:

| Channels | Before | After | Δ |
|---|---|---|---|
| 10 | 44.9 ms | 29.2 ms | −35 % |
| 40 | 92.7 ms | 49.6 ms | −46 % |
| 100 | 207.9 ms | 110.0 ms | **−47 %** |

Marginal cost per channel: **1.81 ms → 0.90 ms**.

The fix replaces N per-channel preference queries with a single
`findPrefsForUser(userId)` (a batch reader that already existed). The mute decision
itself is unchanged — still `isMuted` from `lib/notificationMute.ts`, still the
single owner of that policy — only the data access became a batch.

**Fail-closed behaviour is preserved:** if the preference store is unavailable the
endpoint still returns `{channels: [], total: 0}` rather than showing badges for
channels that might be muted. `tests/notification-prefs-route.test.ts` asserts this;
the existing test was updated to mock the batch reader instead of the per-channel
one, and its assertion was not weakened.

**Remaining, not fixed:** the other half — `resolvePermissions(user.id, serverId,
channelId)` per channel — still costs ~0.90 ms/channel (~180 ms at the 200 cap).
Each call re-fetches the server row, the membership row, and the member's roles;
when many channels share one server, that work is repeated identically per channel.
The obvious fix is a request-scoped memo of the per-`(user, server)` portion inside
`resolvePermissionResolution`, leaving channel overrides per-channel.

That change was **deliberately not made here**: it edits the permission engine, and
a permissions refactor validated only by a benchmark is not a safe trade. It is
recorded with its measurement so it can be done with proper review.
