# Redis — Production Readiness

**Status: validated live on 2026-08-23.** Redis integration already existed in
the codebase with graceful in-memory fallback. Nothing was redesigned; this
document records what was verified, what production requires, and how to check
it yourself.

---

## Why it matters

Without Redis, Bridge is **single-instance only**. Three subsystems keep state
per process:

| Subsystem | Without Redis | Consequence with 2+ instances |
|---|---|---|
| Socket.IO adapter | Skipped | **Instances cannot deliver each other's messages.** Two users on different processes never see each other's traffic. Hard blocker. |
| Rate limiting | Per-process in-memory counters | Effective limits multiply by instance count — 3 instances = 3× the intended ceiling |
| CSRF tokens | In-memory LRU (50k cap, 1 h TTL) | Token minted on instance A fails on B → apparently random 403s behind a load balancer |

Sessions are **already multi-instance safe** — refresh tokens live in
PostgreSQL (`refresh_tokens`) with reuse detection. No change needed there.

---

## Verified behaviour

Started `redis:7-alpine` on `127.0.0.1:6380` and booted the server with
`REDIS_URL` set.

**1. Socket.IO adapter activates**

```
event: redis.connected          "Redis singleton bağlandı."
event: redis.adapter_ready      "Socket.io Redis adapter kuruldu."
event: socket.redis_adapter.applied  "[Socket] Redis adapter aktif — cluster modu."
```

Without `REDIS_URL` the same boot logs a warning instead:
`socket.redis_adapter.skipped` → "tek instance modunda çalışılıyor".

**2. Rate limiting moves to Redis**

After one registration request:

```
rl:register:ip:127.0.0.1
rl:global:ip:127.0.0.1
```

**3. CSRF tokens move to Redis**

After `GET /api/csrf-token`:

```
security:csrf:c60f5b79-209b-4392-8bd4-2d6fdef161ae
```

Key shape is `security:csrf:<userId>` with a 3600 s TTL
(`server/lib/security.ts`).

**4. Full browser suite passes with Redis enabled**

Playwright chromium project: **247 passed, 0 failed, 54 skipped.**

> Note: enabling Redis actually *fixed* three attachment tests that failed on
> the in-memory path, because shared rate-limit state stopped the long suite
> from tripping its own anti-spam thresholds.

---

## Production configuration

### Required

```bash
REDIS_URL=redis://:<password>@<host>:6379
```

In `NODE_ENV=production` the startup validator **refuses to boot without it**,
alongside `AP_ENCRYPTION_KEY` (64-char hex), `FEDERATION_SECRET` (≥32 chars)
and `METRICS_SECRET` (≥16 chars). This is intentional — a production instance
must not silently run in single-node mode.

### Recommended

| Setting | Value | Why |
|---|---|---|
| `maxmemory-policy` | `noeviction` | CSRF tokens and rate-limit counters must not be evicted under pressure — eviction turns into random 403s and bypassed limits |
| Persistence | AOF or RDB | Not strictly required (all keys are short-TTL), but avoids a thundering herd of re-auth after a restart |
| TLS | `rediss://` | Required if Redis is not on a private network |
| `requirepass` | set | Never expose an unauthenticated Redis |

Bridge shares **one** Redis client across the adapter, rate limiter and CSRF
store (`lib/redisAdapter.ts`), so a single instance/connection pool is enough.

---

## Deployment steps

1. Provision Redis 7+ reachable from every app instance.
2. Set `REDIS_URL` in every instance's environment.
3. Boot **one** instance; confirm the three log lines under "Verified
   behaviour" above.
4. Scale to 2+ instances behind a load balancer.
5. Run the multi-instance checks below.

---

## Multi-instance validation checklist

These cannot be proven with one process. Run them after scaling out.

| # | Check | Expected | Result |
|---|---|---|---|
| R-1 | User A on instance 1, user B on instance 2, same channel | B receives A's message in real time | |
| R-2 | A joins a voice channel on instance 1; B on instance 2 | B sees A in the participant list | |
| R-3 | Exhaust a rate limit against instance 1, immediately retry on instance 2 | Still limited — counters are shared | |
| R-4 | `GET /api/csrf-token` from instance 1, use it in a mutating request on instance 2 | Accepted | |
| R-5 | Log in on instance 1, call `/api/refresh` on instance 2 | Works (sessions are in PostgreSQL) | |
| R-6 | Stop Redis while both instances run | Both log the failure; behaviour degrades **visibly**, not silently | |
| R-7 | Restart Redis | Instances reconnect without a restart | |

> R-6 matters most. The in-memory fallback is correct for a single node and
> **dangerous** after scaling out: the app keeps serving while cross-instance
> delivery silently stops. Alert on `redis.no_url` and
> `socket.redis_adapter.skipped` in production.

---

## Local reproduction

```bash
docker run -d --name bridge-redis -p 127.0.0.1:6380:6379 redis:7-alpine
```

Then start the server with `REDIS_URL=redis://127.0.0.1:6380` and inspect:

```bash
docker exec bridge-redis redis-cli --scan --count 200
```

You should see `rl:*` keys after any API call and `security:csrf:*` after
requesting a CSRF token.
