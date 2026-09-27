# DEPLOYMENT — Bridge v1.123

Documents the deployment architecture Bridge **actually supports**. Nothing here is
aspirational; where something is unvalidated it says so.

---

## 1. Architecture

```
                        ┌──────────────────────┐
     users ────TLS────▶ │  reverse proxy       │  infra/nginx-site.conf
                        │  (nginx)             │  infra/nginx-upstream.conf
                        └───────┬──────────────┘
                                │ HTTP + WebSocket upgrade
                                ▼
                        ┌──────────────────────┐
                        │  Bridge server       │  Express 5 + Socket.IO
                        │  (1..N instances)    │  /api/health, /metrics
                        └───┬───────┬──────┬───┘
                            │       │      │
          ┌─────────────────┘       │      └──────────────────┐
          ▼                         ▼                         ▼
   ┌─────────────┐          ┌─────────────┐          ┌────────────────┐
   │ PostgreSQL  │          │   Redis     │          │ object storage │
   │ REQUIRED    │          │ REQUIRED    │          │ or local disk  │
   │ durable     │          │ rate-limit  │          │ uploads        │
   │ state       │          │ authority,  │          │ (durable)      │
   │             │          │ CSRF,       │          └────────────────┘
   │             │          │ socket      │
   │             │          │ adapter     │          ┌────────────────┐
   └─────────────┘          └─────────────┘          │ TURN / SFU     │
                                                     │ OPTIONAL       │
          ┌──────────────┐                           │ (voice only)   │
          │ backup job   │──▶ /backups               └────────────────┘
          │ pg_dump +    │
          │ uploads sync │
          └──────────────┘
```

**Multi-instance requires Redis.** The Socket.IO Redis adapter is what lets a message
sent on instance A reach a user connected to instance B. Without `REDIS_URL`, running
more than one instance silently breaks fan-out — users appear online but never receive
messages from anyone on another instance.

## 2. Supported topologies

| Topology | Assets | Status |
|---|---|---|
| Single node, Docker Compose | `docker-compose.yml`, `docker-compose.prod.yml` | Supported; the simplest correct deployment |
| Multi-instance behind nginx | `docker-compose.cluster.yml`, `infra/nginx-upstream.conf` | Supported in configuration; **cross-instance fan-out not validated in this pass** |
| Kubernetes | `k8s/bridge.yaml`, `k8s/README.md` | Already present in the repo. **Not exercised here.** Documented rather than rewritten — validate before relying on it. |

Kubernetes was **not introduced** by this pass; it already existed.

## 3. Startup order

1. PostgreSQL reachable
2. Redis reachable (production requires it — Bridge fails closed otherwise)
3. Migrations run to completion
4. Application starts
5. Health gate passes (~3.4 s cold start, measured)
6. Proxy admits traffic

## 4. Reverse proxy requirements

- **WebSocket upgrade must be forwarded** (`Upgrade` / `Connection` headers), or
  Socket.IO degrades or fails outright
- **Set `TRUSTED_PROXY_COUNT`** to the number of proxy hops. Unset means Bridge
  ignores `X-Forwarded-For` entirely and every client looks like a single IP — which
  makes per-IP rate limiting and IP bans affect all users together. Too high lets
  clients forge their own address
- Terminate TLS at the proxy; set `ALLOWED_ORIGINS` and `BASE_URL` to the public origin
- Proxy read timeout must exceed the WebSocket idle interval

## 5. Zero-downtime — NOT PROVEN

No rolling deploy has been validated for Bridge. Do not claim zero downtime.

Why it is non-trivial here:

- Long-lived WebSocket connections must drain rather than be cut
- Migrations must be compatible with old and new code simultaneously
- Multi-instance fan-out via Redis is itself unvalidated

**Recommended for the private beta:** a short announced maintenance window.

```
announce -> stop traffic -> backup -> migrate -> deploy -> verify -> resume
```

Blue/green is the natural next step once multi-instance fan-out is proven: run the new
colour alongside, verify health, switch the proxy, keep the old colour warm for
rollback. That is a design, not a validated procedure.

## 6. Database changes

Follow expand → deploy → backfill → contract (`RUNBOOK-ROLLBACK.md` §2).
**Always back up before migrating** — code rolls back, databases do not.

## 7. Scaling notes

Measured on a single local instance (30 virtual users, mixed realistic endpoints):
7,560 requests, **0 errors**, p50 8.2 ms / p95 11.2 ms / p99 13.2 ms, ~75 req/s,
RSS 116 → 244 MB under load, latency returning to ~4 ms once load stopped.

The first cost to watch is **per-channel permission resolution** on the unread path
(~0.9 ms per channel after the v1.123 batching fix, up to a 200-channel cap). That is
the known next bottleneck, documented with measurements in `OBSERVABILITY.md`.

These figures come from one local machine and are **not** a capacity model.
