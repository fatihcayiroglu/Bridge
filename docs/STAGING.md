# STAGING — Bridge v1.123

Staging exists to answer one question: **would this release survive production?**
It is only useful if it fails the same way production would.

---

## 1. Hard rule: separate everything

Staging must never share a resource with production.

| Resource | Requirement |
|---|---|
| PostgreSQL | Separate database **and** separate server/instance |
| Redis | Separate instance, or at minimum a separate namespace on a separate instance |
| Object storage | Separate bucket |
| Secrets | Separate `JWT_SECRET`, `REFRESH_SECRET`, `AP_ENCRYPTION_KEY`, `FEDERATION_SECRET`, `METRICS_SECRET` |
| Domain / origin | Separate hostname |
| WebAuthn | Separate `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` — passkeys are origin-bound and will not work otherwise |
| OAuth / OIDC / SAML | Separate client registration with staging callback URLs |
| TURN / SFU | Separate credentials |

**Never point staging at production.** A staging bug that writes to a production
database is not a staging bug any more.

## 2. What was validated in v1.123

Executed on disposable local infrastructure (`bridge-review-*` containers,
`bridge_dr_123` database):

| Check | Result |
|---|---|
| Startup with separate DB/Redis | PASS |
| Migrations applied to a fresh database | PASS — `parentMessageId` nullable, `locked` present |
| Health endpoint gating | PASS (~3.4 s cold start) |
| Login + session | PASS |
| Server/channel/message reads | PASS |
| Forum threads, polls, scheduled messages, boosts, badges | PASS |
| WebSocket connect / reconnect / cleanup | PASS — sockets returned to 0, no leak |
| Production-like `MAX_WS_PER_IP=10` behaviour | PASS — exactly 10 per IP, 11th refused |
| HTTP load (30 VUs, 7,560 requests) | PASS — 0 errors, p95 11.2 ms |
| Redis outage and unattended recovery | PASS — `503` → `200` in 3 s |
| Backup → restore → boot → smoke | PASS — 11/11 |
| Cross-browser core (Chromium/Firefox/WebKit) | PASS |

## 3. What could NOT be validated here — DOCUMENTED FOR EXTERNAL STAGING

These require infrastructure this environment does not have. They are **not** claimed
as passing:

| Item | Why not |
|---|---|
| Real TLS certificate and public domain | No public DNS/cert in this environment |
| Reverse proxy in front (nginx configs exist in `infra/`) | Not exercised end-to-end |
| `TRUSTED_PROXY_COUNT` behaviour behind a real proxy | Needs an actual proxy hop |
| OAuth/OIDC/SAML round trip | Needs a real IdP registration |
| SMTP delivery | No mail provider configured |
| Object storage (S3/R2/B2) | No provider configured; MinIO present but not exercised for uploads |
| TURN relay across real NAT | Needs two networks |
| SFU under real media load | Needs real clients |
| Multi-instance deployment + Redis adapter fan-out | Single instance only |
| Rolling / zero-downtime deploy | Never attempted — **do not claim it** |

## 4. Bringing staging up

```bash
# 1. dependencies
docker compose up -d postgres redis          # separate instances

# 2. configuration (separate secrets, separate origin)
export NODE_ENV=production
export DATABASE_URL=...                      # staging DB
export REDIS_URL=...                         # staging Redis
# JWT_SECRET, REFRESH_SECRET, AP_ENCRYPTION_KEY,
# FEDERATION_SECRET, METRICS_SECRET  — all staging-specific

# 3. validate configuration BEFORE starting
node server/dist/lib/env.js                  # exits non-zero and lists problems

# 4. migrate
cd server && npm run db:migrate:pg

# 5. start, then gate on health
curl -sf http://<staging>/api/health
```

## 5. Staging smoke checklist

Run after every staging deploy:

- [ ] `/api/health` returns 200
- [ ] Login succeeds
- [ ] Server list and channel list render
- [ ] Send a message; a second client receives it
- [ ] Upload a file; it serves back
- [ ] Soundboard list loads
- [ ] Disconnect/reconnect a client; state recovers
- [ ] Stop Redis → `503`; start Redis → `200` unattended
- [ ] Graceful shutdown leaves no orphaned sockets

## 6. Data in staging

Staging must not contain production personal data. Either seed synthetic data, or
restore a production backup **with the understanding that it then carries the same
privacy obligations as production** — in which case access must be restricted
identically. Prefer synthetic.
