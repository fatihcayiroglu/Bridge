# CONFIGURATION REFERENCE — Bridge v1.123

**No real values appear in this document.** Only names, classes and constraints.

Bridge validates configuration at startup in `server/lib/env.ts` and calls
`process.exit(1)` when a production-critical value is missing or malformed.

---

## 1. Startup validation — verified behaviour

Booting with `NODE_ENV=production` and deliberately weak secrets produces:

```
╔══════════════════════════════════════════════════════════╗
║  [ENV] KRİTİK — Eksik/hatalı ortam değişkenleri          ║
╚══════════════════════════════════════════════════════════╝
  ✗ JWT_SECRET en az 32 karakter olmalı (mevcut: 8)
  ✗ REFRESH_SECRET en az 32 karakter olmalı (mevcut: 12)
  ✗ REDIS_URL production ortamında zorunludur (rate limit, CSRF, socket adapter)
  ✗ AP_ENCRYPTION_KEY production ortamında 64-char hex (32 byte) olmalıdır
  ✗ FEDERATION_SECRET production ortamında en az 32 karakter olmalıdır
  ✗ METRICS_SECRET production ortamında en az 16 karakter olmalıdır
```

Two properties worth stating explicitly, both verified:

1. **Secrets are never printed.** The validator reports the *length* of an offending
   value, never the value. `redact: true` is set on every secret.
2. **It fails loudly, not silently.** A production instance cannot start with a weak
   `JWT_SECRET` — there is no "warn and continue" path for these.

There are **231** distinct `process.env` reads across the server. The table below
covers the production-relevant ones; the rest are tuning knobs with safe defaults.

---

## 2. Classification

### 2.1 Production-required (startup fails without them)

| Variable | Constraint | Notes |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `JWT_SECRET` | required, ≥ 32 chars, **secret** | access token signing |
| `REFRESH_SECRET` | required, ≥ 32 chars, **secret** | refresh token signing |
| `REDIS_URL` | required in production | rate limit authority, CSRF, socket adapter |
| `AP_ENCRYPTION_KEY` | 64-char hex (32 bytes), **secret** | federation key encryption at rest |
| `FEDERATION_SECRET` | ≥ 32 chars, **secret** | federation signing |
| `METRICS_SECRET` | ≥ 16 chars, **secret** | protects `/metrics` |

### 2.2 Security-critical (wrong value = security consequence)

| Variable | Why it matters |
|---|---|
| `TRUSTED_PROXY_COUNT` | **Unset ⇒ Bridge does not trust `X-Forwarded-For` at all.** Behind a reverse proxy this makes every client look like one IP, so rate limits and IP bans hit *all users together*. Set it to the exact proxy hop count — too high lets clients forge their own IP. |
| `ALLOWED_ORIGINS` | CORS allowlist. Never `*` in production. |
| `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID` | Passkey origin binding. Multi-origin handling was hardened in v1.122.0. |
| `BASE_URL` / `INSTANCE_URL` | Used in links, federation identity and WebAuthn. A wrong value breaks passkeys and federation trust. |
| `MAX_WS_PER_IP` (default 10) | Per-IP concurrent socket ceiling — **see §4, this has real NAT consequences**. |
| `MAX_UNAUTH_WS_PER_IP` (default 3) | Pre-auth socket ceiling. |
| `MAX_WS_PER_USER` | Per-account socket ceiling. |
| `OIDC_CLIENT_SECRET`, `SMTP_PASS`, `TURN_*`, `S3/B2/R2` keys, `HCAPTCHA_SECRET`, push keys (`APNS_*`, `VAPID_*`) | Provider credentials — all **secret**. Verify web push for one user with `cd server && npx ts-node scripts/test-push.ts <userId>`. |

### 2.3 Optional (feature degrades or is disabled)

`CDN_PROVIDER` and storage credentials, `WEBP_CONVERT`, `SMTP_*`, `OIDC_*`, `SAML_*`,
`TURN_*`, SFU/mediasoup settings, `ABUSEIPDB_KEY`, AI provider keys
(`GEMINI_API_KEY`, `GROQ_API_KEY`), `S3_BUCKET`/`S3_ENDPOINT` for offsite backup.

Absence disables the feature; it must never weaken a security control.

### 2.4 Tuning (safe defaults, change only with evidence)

`ACCESS_TOKEN_TTL`, `MEDIA_TOKEN_TTL`, `MAX_FILE_SIZE_MB`, `CHUNK_SIZE_MB`,
`MAX_SERVERS_PER_USER`, `MAX_CHANNELS_PER_SERVER`, `LOG_LEVEL`,
`REDIS_COMMAND_TIMEOUT_MS`, `REDIS_RECOVERY_PROBE_MS`,
`REDIS_RECONNECT_MAX_DELAY_MS` (added in v1.123), `AP_INBOX_*` rate limits,
`RL_*` rate-limit knobs, `BACKUP_KEEP_DAYS`.

### 2.5 Development / test only — must never appear in production

| Variable | Purpose |
|---|---|
| `E2E_MAX_WS_PER_IP`, `E2E_MAX_WS_PER_USER` | Raise socket ceilings so load measurement is not clamped by the protection itself |
| `E2E_RL_SOCKET_CONNECT_MAX`, `E2E_RL_SOCKET_HS_MAX`, `E2E_RL_REGISTER_MAX` | Relax rate limits for fixture creation |
| `UI_BASE_URL`, `BASE_URL` overrides in E2E | Test targeting |

These are consumed **only** by `scripts/e2e-server.js`, which is a test harness and is
not part of a production deployment. The production defaults it overrides are
deliberately left unchanged in source.

---

## 3. Secrets handling

- **No private `.env` is committed.** `server/.env` is a local development file and is
  removed before packaging (verified in the v1.123 package scan: `private env = 0`).
- Secrets are injected at runtime (environment / orchestrator secret store).
  `docs/ADR-0012-secrets-management.md` records the decision.
- The validator redacts every secret; logs never contain secret values.

### Rotation

| Secret | Rotation effect | Procedure |
|---|---|---|
| `JWT_SECRET` | All access tokens invalid immediately | Rotate during a maintenance window, or dual-accept old+new briefly. Users re-authenticate. |
| `REFRESH_SECRET` | All sessions invalid — every user logged out | Announce first. Highest user impact. |
| `METRICS_SECRET` | `/metrics` scraper must be updated | Update Prometheus config in the same change. |
| `AP_ENCRYPTION_KEY` | **Encrypts federation keys at rest — rotating without re-encrypting makes stored keys unreadable** | Follow `docs/AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md`. Never rotate ad hoc. |
| `FEDERATION_SECRET` | Peer signature verification breaks until peers refresh | Coordinate with peers. |
| OIDC / SMTP / TURN / storage | Provider-side rotation, then update Bridge | Rotate in the provider, deploy new value, verify, then revoke the old one. |

**No real credential was rotated during this pass** — the procedures above are
documented, not exercised.

---

## 4. The shared-IP (NAT) consequence — MEASURED

`MAX_WS_PER_IP` defaults to **10**. Measured against a server running that production
value, connecting authenticated sockets sequentially from a single IP:

```
SEQUENTIAL connects that succeeded from ONE IP: 10
errors: {"TOO_MANY_CONNECTIONS_FROM_IP": 1}
```

Exactly 10 succeed; the 11th is refused.

**Real-world meaning:** a school, office, dormitory or CGNAT range shares one public
IP. With the default, **at most 10 concurrent Bridge users exist behind that IP** —
the 11th person cannot connect at all. `MAX_UNAUTH_WS_PER_IP = 3` additionally caps
how many can be *connecting* simultaneously.

The related rate-limit note already in `scripts/e2e-server.js` records the same class
of risk for connection rate: 20+ users opening Bridge in the same minute from one
NAT can trip an IP-wide block.

**Not changed in this pass, deliberately.** Raising a DoS control is a security
decision, and the crude fix (a bigger number) weakens protection for genuinely
hostile single-IP floods. The evidence-backed operational mitigation is:

> For any deployment expected to serve users behind shared NAT, set
> `MAX_WS_PER_IP` to a value matching the largest expected concurrent population
> behind one address, **and** set `TRUSTED_PROXY_COUNT` correctly so that per-IP
> accounting uses the real client address rather than the proxy's.

The durable fix is account-aware limiting — keep the strict pre-auth per-IP cap,
keep the per-account cap, and let the *authenticated* per-IP ceiling be higher,
because each authenticated socket is already bounded per user. That is a design
change with security review attached and is recorded as post-beta work, not
smuggled into a release pass.
