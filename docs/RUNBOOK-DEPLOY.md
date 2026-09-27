# RUNBOOK — DEPLOY

Scope: deploying a Bridge release to staging or production.

---

## Pre-flight (all must pass)

| Gate | Command |
|---|---|
| Server tests | `cd server && npm test` |
| Client tests | `npm run test:svelte` |
| Typechecks (5 projects) | `npm run typecheck` |
| svelte-check | `npm run typecheck:svelte` |
| Lint | `npm run lint && npm run lint:client` |
| Production dependency audit | `npm audit --omit=dev` → **0 vulnerabilities** |
| Release integrity | `npm run test:release-integrity` |
| Builds | `npm run build` and `cd server && npm run build` |
| E2E (Chromium) | `cd e2e && npx playwright test --project=chromium` |

Do not deploy with an unexplained failure. "Probably flaky" is not an explanation —
run it in isolation and establish *why* before proceeding.

## Configuration check

```bash
NODE_ENV=production node dist/lib/env.js
```

Bridge exits non-zero and lists every missing or malformed production-critical
variable. It reports **lengths, never values**. See `CONFIGURATION.md`.

For any deployment serving users behind shared NAT (school/office/dorm/CGNAT), review
`MAX_WS_PER_IP` — the default of 10 means **only 10 concurrent users per public IP**
(measured). Also set `TRUSTED_PROXY_COUNT` to the real proxy hop count, or per-IP
accounting will treat every user as one client.

## Order of operations

Service startup order matters:

1. **PostgreSQL** — must be reachable first
2. **Redis** — required in production; Bridge fails closed without it
3. **Migrations** — run to completion *before* new code serves traffic
4. **Application** — start one instance, verify, then scale
5. **Reverse proxy / load balancer** — admit traffic only after health passes

## Migrations

```bash
cd server && npm run db:migrate:pg
```

Follow the expand → deploy → backfill → contract discipline in
`RUNBOOK-ROLLBACK.md §2`. Never ship a destructive migration in the same release as
the code that stops using the column.

**Take a backup before any migration** (`backup/backup.sh`) — code rolls back,
databases do not.

## Health gating

| Endpoint | Meaning |
|---|---|
| `GET /api/health` | Returns `200` when the instance can serve traffic |

Note: with `REDIS_URL` set, health returns `503` while Redis is unreachable. This is
deliberate — the instance genuinely cannot serve requests. See
`RUNBOOK-REDIS-OUTAGE.md`.

**Measured cold start:** ~3.4 s from process start to `200`. Set readiness probe
timeouts above that with margin.

## WebSocket considerations

Bridge is Socket.IO-based. During deploy:

- Clients reconnect automatically; a reconnect wave is expected
- With multiple instances, `REDIS_URL` **must** be set — the Redis adapter is what
  makes fan-out work across instances. Without it, users on different instances stop
  seeing each other's messages
- Verify after deploy: `bridge_active_sockets` returns to its normal level

## Rolling / zero-downtime

**Not proven.** No multi-instance rolling deploy has been validated for Bridge.

Do **not** claim zero-downtime. Until it is tested, use a short maintenance window:

1. Announce
2. Stop traffic
3. Backup
4. Migrate
5. Deploy
6. Verify
7. Restore traffic

## Post-deploy verification

```bash
curl -s /api/health                       # 200
curl -s /metrics | grep bridge_http_errors_total
```

Then manually: log in, open a server, send a message, confirm it appears for a second
client. Watch `bridge_http_errors_total` and `bridge_active_sockets` for 15 minutes.

## Rollback

See `RUNBOOK-ROLLBACK.md`. Decide within 15 minutes — a long partial outage is worse
than a rollback.
