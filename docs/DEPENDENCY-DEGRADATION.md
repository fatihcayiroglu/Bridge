# DEPENDENCY DEGRADATION & RECOVERY — Bridge v1.123

How Bridge behaves when a backing service is unavailable, and what was **actually
measured** by taking those services down.

All experiments in this document were run against a **disposable local environment**
(`bridge_e2e_123` database, `bridge-review-*` containers). No production or shared
system was touched.

---

## 1. Dependency classification

| Dependency | Class | Behaviour when unavailable |
|---|---|---|
| **PostgreSQL** | **Required** | No meaningful degraded mode — Bridge is a persistence-backed service. |
| **Redis** (when `REDIS_URL` is set) | **Required, fail-closed** | Every request is rejected with `503`. See §2 — this is deliberate. |
| **Redis** (when `REDIS_URL` is unset) | **Optional** | Single-node mode; the rate limiter falls back to a process-local store. `redisAdapter` warns at startup that horizontal scaling will not work. |
| **MinIO / S3 / R2** | Optional | Upload paths fail; the rest of the product is unaffected. |
| **Voice / SFU (mediasoup)** | Optional | Text and all non-voice features continue. |
| **External CDN (`CDN_PROVIDER`)** | Optional | Falls back to Bridge-authorised URLs (covered by `webp-upload.spec.ts:167`). |

---

## 2. Redis outage — measured **[EXECUTED + VERIFIED]**

### 2.1 During the outage: total rejection, and that is correct

With `REDIS_URL` configured, Redis is the **authoritative** rate-limit store. When it
is unreachable, `redisAuthoritativeCommand` throws and the rate limiter rejects the
request:

```
503 {"error":"Rate limit service temporarily unavailable"}
```

Measured — `docker stop bridge-review-redis`, then:

| Endpoint | Before | During outage |
|---|---|---|
| `GET /api/health` | `200` (4.8 ms) | `503` (2.4 ms) |

**This fail-closed behaviour is correct and was not changed.** If the limiter failed
*open*, an attacker who could disrupt Redis would thereby switch off every rate limit
in the product — brute-force protection, spam limits, upload limits. Rejecting is the
safe direction.

`/api/health` returning `503` is likewise defensible: the instance genuinely cannot
serve requests, and a readiness probe should say so.

### 2.2 After the outage: the server never came back — **DEFECT, now fixed**

The serious finding is what happened when Redis **returned**.

Measured sequence (original code):

| Step | Observation |
|---|---|
| 1. Redis stopped | `503` — expected |
| 2. ~30 s elapsed | reconnect budget exhausted (`redis.reconnecting` ×12, no further attempts) |
| 3. Redis restarted, verified reachable from the host (`+PONG` over TCP to `127.0.0.1:56379`) | — |
| 4. Polled `/api/health` for **60+ s** | **still `503`**, and **no new `redis.reconnecting` events** |

The process never recovered. Only a restart cleared it.

#### Root cause

`server/lib/redisAdapter.ts`:

```ts
reconnectStrategy: (retries: number) => {
  if (retries > 10) return new Error('Redis: 10 bağlantı denemesi başarısız');
  return Math.min(retries * 200, 3000);
}
```

Returning an `Error` from `reconnectStrategy` tells node-redis to **stop reconnecting
permanently**. With a 3 s backoff cap, the budget is spent after roughly 30 seconds
of downtime — shorter than an ordinary Redis restart, failover, or deploy.

The failure then chains:

```
client permanently dead
  → _isRedisAvailable permanently false
  → rate limiter cannot reach its authority
  → fail-closed 503 on every request
  → /api/health also 503
  → load balancer removes every instance and never restores it
```

So a **transient** Redis blip becomes a **permanent, fleet-wide** outage requiring
manual intervention on every node.

#### Fix

Retries are now **unbounded**; only the *interval* is capped:

```ts
reconnectStrategy: (retries: number) =>
  Math.min(retries * 200, REDIS_RECONNECT_MAX_DELAY_MS),   // default 3 000 ms
```

Unlimited attempts do not mean a hot loop — the delay grows and then holds at the
ceiling, so a Redis that stays down costs one connection attempt every 3 s.
`REDIS_RECONNECT_MAX_DELAY_MS` (100–60 000) tunes the ceiling.

The fail-closed rate-limit behaviour was **not** altered. The bug was never that
Bridge rejected traffic during the outage; it was that Bridge could not come back
afterwards.

#### Verification — same experiment, after the fix

| Step | Before fix | After fix |
|---|---|---|
| Redis up | `200` | `200` |
| Redis down 50 s (deliberately longer than the old 30 s budget) | `503` | `503` (unchanged, correct) |
| Redis restored | **`503` indefinitely; never recovered** | **`200` within 3 s, unattended** |

Log evidence after the fix: `redis.reconnecting` ×26 and a **second** `redis.ready` —
the client kept trying and re-established the connection on its own.

#### Regression protection

`server/tests/redis-reconnect-never-gives-up.test.ts` — 3 tests:

1. `reconnectStrategy` never returns an `Error`, at any retry count up to 100 000.
2. The delay grows and then holds at a 3 000 ms ceiling (no hot loop).
3. The ceiling is configurable, and configuring it does not reintroduce giving up.

Verified non-vacuous: restoring the old strategy turns **all three** red.

### 2.3 Incidental confirmation of request correlation

The rate-limit rejection logs captured during this experiment carry the new
correlation id:

```json
{"event":"ratelimit.authority_unavailable","requestId":"c0d70aedc72bb5bb06e3b3d7696b27f5", …}
```

This is live evidence for the middleware-ordering decision recorded in
`OBSERVABILITY.md`: `requestIdMiddleware` is mounted **before** `securityHeaders`
precisely so that early-returning middleware — rate limit, CSRF, IP ban — still emit
correlated logs. Those rejections are the ones an operator most needs to trace, and
they are exactly what a later mount point would have missed.

---

## 3. Not yet validated

Honest gaps — these were **not** exercised, and nothing in this document should be
read as covering them:

| Scenario | Status |
|---|---|
| PostgreSQL taken down mid-traffic | **Not tested** |
| MinIO/S3 unavailable during upload | **Not tested** |
| SFU/mediasoup failure under live voice load | **Not tested** |
| Redis outage under concurrent load (not just health polling) | **Not tested** — the measurements above used an idle instance |
| Partial Redis failure (reachable but erroring, e.g. OOM) | **Not tested** — `docker stop` produces a clean disconnect, not a degraded server |
| Multi-node behaviour during a Redis partition | **Not tested** — single instance only |

The Redis recovery defect was found because the scenario was actually executed rather
than reasoned about. The rows above deserve the same treatment before any production
launch; the same method applies (disposable environment, stop the dependency, restore
it, and check that the service returns **without** human intervention).
