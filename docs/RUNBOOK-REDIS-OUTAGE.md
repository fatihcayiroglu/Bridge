# RUNBOOK — REDIS OUTAGE

**Severity:** SEV-1 (full service rejection while Redis is unreachable).
**Expected recovery:** automatic, no restart. Verified in v1.123.

---

## Symptoms

- Every request returns `503 {"error":"Rate limit service temporarily unavailable"}`
- `GET /api/health` returns `503` — load balancer marks all instances unhealthy
- Logs show, repeatedly:
  ```
  event=ratelimit.redis.error       "Redis authoritative command unavailable: rate limit sliding window"
  event=ratelimit.authority_unavailable  "…request rejected fail-closed."
  ```

## This rejection is CORRECT — do not "fix" it by failing open

When `REDIS_URL` is configured, Redis is the **authoritative** rate-limit store. If it
is unreachable Bridge rejects requests rather than serving them unlimited. Failing
open would mean anyone who can disrupt Redis thereby switches off every rate limit in
the product — brute-force protection, spam limits, upload limits.

**Never** set the limiter to fail open to clear an outage.

## Checks

```bash
# 1. Is Redis actually up?
redis-cli -u "$REDIS_URL" ping            # expect PONG

# 2. Is it reachable FROM the app host (not just from your laptop)?
#    A container/network issue looks identical to a dead Redis from the outside.

# 3. Is the app still trying to reconnect?
#    Expect repeated redis.reconnecting events; their ABSENCE is the bad sign.
grep -o '"event":"redis\.[a-z_]*"' /var/log/bridge.log | sort | uniq -c
```

Interpreting the last one:

| Observation | Meaning |
|---|---|
| `redis.reconnecting` still increasing | Healthy retry loop — Bridge will recover on its own |
| `redis.ready` appears again | Recovered |
| **No new `redis.reconnecting` while Redis is up** | The v1.122 defect (see below). Restart the process. |

## Recovery

**Normal path: do nothing to Bridge.** Fix Redis; Bridge reconnects unattended.

Measured in v1.123 with the fix in place:

| Phase | Result |
|---|---|
| Redis stopped | `503` (correct) |
| Outage held 50 s (longer than the old 30 s retry budget) | `503` |
| Redis restored | **`200` within 3 s, no human action** |

Evidence: 26 `redis.reconnecting` attempts and a second `redis.ready`.

## Historical defect — why this runbook exists

Before v1.123, `reconnectStrategy` returned an `Error` after 10 retries, which makes
node-redis stop reconnecting **permanently**. With a 3 s backoff cap the budget was
spent after roughly 30 seconds — shorter than an ordinary Redis restart.

Measured consequence: Redis came back and was verified reachable, yet Bridge stayed at
`503` for 60+ seconds with **no further reconnect attempts**, and never recovered
without a process restart. Because `/api/health` sits behind the same limiter, a load
balancer would have evicted every instance and never restored one — a transient
dependency blip becoming a permanent fleet outage.

Fixed by making retries unbounded with a bounded interval
(`REDIS_RECONNECT_MAX_DELAY_MS`, default 3000 ms). Guarded by
`server/tests/redis-reconnect-never-gives-up.test.ts`.

**If you ever see the "no new reconnect attempts" signature again, that regression is
back.** Restart the affected instances to restore service, then treat it as a code
defect, not an infrastructure one.

## What is lost during the outage

| Data | Impact |
|---|---|
| Rate-limit counters | Reset — acceptable |
| Presence / online state | Rebuilds as clients reconnect |
| Socket leases, caches | Rebuild |
| **Anything durable** | **Nothing.** Redis holds no sole copy of any data. |

No database restore is ever required for a Redis outage.

## Escalate when

- Redis is up and reachable but Bridge stays `503` past ~10 s → suspected reconnect
  regression; restart instances and raise a defect
- Redis cannot be restored → consider running temporarily **without** `REDIS_URL`
  (single-node mode: process-local rate limiting, no horizontal scaling). This is a
  degraded, single-instance configuration only — never run multiple instances that
  way, because rate limits and socket leases would stop being shared.
