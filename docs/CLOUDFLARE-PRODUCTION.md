# CLOUDFLARE PRODUCTION — Bridge v1.124

How to put Bridge safely on the public Internet behind Cloudflare.

**Replace `bridge.example.com` with your real domain everywhere.** No DNS record,
certificate or Cloudflare setting described here has been created — this repository
has no Cloudflare account. Sections marked **BLOCKED ON OPERATOR** need you.

---

## 1. Architecture

```
                    ┌──────────────────────────────────────┐
   browser ──HTTPS──►  CLOUDFLARE EDGE (proxied, orange)   │
   Electron          │  TLS · WAF · edge rate limit · cache │
   mobile            └───────────────┬──────────────────────┘
                                     │ HTTPS  (Full strict)
                                     ▼
                    ┌──────────────────────────────────────┐
                    │  ORIGIN nginx                        │  infra/nginx-cloudflare.conf
                    │  real-IP · WS upgrade · /metrics deny │
                    └───────────────┬──────────────────────┘
                                    │ HTTP (private network)
                     ┌──────────────┴───────────────┐
                     ▼                              ▼
             ┌───────────────┐            ┌───────────────┐
             │ Bridge inst 1 │            │ Bridge inst 2 │   (no sticky sessions)
             └───────┬───────┘            └───────┬───────┘
                     └──────────┬─────────────────┘
                                ▼
                  ┌─────────────────────────┐
                  │ PostgreSQL  │  Redis    │  Redis = fan-out + CSRF + limits
                  └─────────────────────────┘

   WebRTC media does NOT go through Cloudflare:
   browser ──UDP/TCP──► turn.bridge.example.com  (DNS-only, grey cloud)
```

## 2. DNS records

| Name | Type | Value | Proxy |
|---|---|---|---|
| `bridge.example.com` | A / AAAA | origin IP | **Proxied (orange)** |
| `cdn.bridge.example.com` | CNAME | R2 custom domain | **Proxied** *(only if R2 public bucket is used)* |
| `turn.bridge.example.com` | A / AAAA | TURN server IP | **DNS-only (grey)** |

**Bridge needs exactly one hostname.** The app, REST API and Socket.IO all live on the
same origin — no separate `api.` host is required, and adding one would create CORS,
cookie and WebAuthn complexity for no benefit. Add `cdn.` only if you actually use a
public R2 bucket; add `turn.` only if you run TURN.

## 3. Proxied vs DNS-only

| Traffic | Treatment | Why |
|---|---|---|
| App HTTPS | **Proxied** | TLS, WAF, DDoS, caching for static assets |
| REST API | **Proxied** | Same origin; cache **bypass** rules required (§8) |
| Socket.IO / WebSocket | **Proxied** | Cloudflare proxies WebSocket natively — enable "WebSockets" in Network |
| Public media / CDN | **Proxied** | Cacheable by design |
| **TURN (UDP/TCP)** | **DNS-only** | Cloudflare's HTTP proxy is not a TURN relay — see §12 |
| **SFU media** | **DNS-only / direct** | Same reason |

## 4. SSL/TLS

**Mode: Full (strict).** Set it in SSL/TLS → Overview.

Do **not** use Flexible: it encrypts browser→Cloudflare but leaves Cloudflare→origin
in plaintext while showing the user a padlock. That is worse than no TLS because it
looks safe.

Origin certificate — pick one:

| Option | When | Notes |
|---|---|---|
| **A. Let's Encrypt** | You want the origin independently valid | Renew via certbot; browsers trust it directly |
| **B. Cloudflare Origin CA** | Origin only ever talks to Cloudflare | 15-year cert. **Browsers do not trust it and are not expected to** — it authenticates Cloudflare↔origin only. Direct browser access to the origin will warn. |

Certificate paths go in `infra/nginx-cloudflare.conf`. Renewal is the operator's
responsibility; Origin CA certs are long-lived, Let's Encrypt needs automation.

## 5. HTTPS enforcement

1. Cloudflare → SSL/TLS → Edge Certificates → **Always Use HTTPS: On**
2. The origin nginx also 301s port 80 → 443 (defence if the edge is bypassed)
3. **HSTS: leave OFF initially.** Turn it on only after every production hostname is
   confirmed HTTPS-correct. Enabling it early can make a misconfigured subdomain
   unreachable in browsers for the whole `max-age`. The nginx directive is present
   but commented out.

## 6. Origin protection

The origin must not be trivially reachable around Cloudflare. Choose **one**:

| Option | Strength | Trade-off |
|---|---|---|
| **Firewall allowlist of Cloudflare IP ranges** | Good | Ranges change — automate updates |
| **Authenticated Origin Pulls** | Good, TLS-layer | Cloudflare presents a client cert; nginx directives are in the config, commented |
| **Cloudflare Tunnel** | Strongest — no inbound ports at all | Connector process; must be validated with WebSocket and your load balancer |

**Recommendation for this beta:** firewall allowlist **plus** Authenticated Origin
Pulls. Tunnel is attractive but would need its own WebSocket and multi-instance
validation, which has not been done here.

> **If the origin stays publicly reachable during the beta, that is temporary
> operational debt and should be written down as such** — an attacker who finds the
> origin IP bypasses WAF, edge rate limiting and bot rules in one step.

**Do not apply the web-origin firewall rules to TURN/SFU ports** (§12).

## 7. Real client IP — the single most important setting

Bridge derives rate limiting, IP bans and shared-IP fairness from client identity.

### Set `TRUSTED_PROXY_COUNT=2` (Cloudflare + nginx)

Cloudflare appends the real client to `X-Forwarded-For`; nginx appends its own hop:

```
X-Forwarded-For: <real client>, <cloudflare POP>
```

Bridge reads backwards by `TRUSTED_PROXY_COUNT`, so 2 selects the real client.

**Verified, not assumed** (`server/tests/cloudflare-client-ip.test.ts`, 11 tests):

| Case | Result |
|---|---|
| Cloudflare chain | real client resolved, **not** the POP |
| Client forges `X-Forwarded-For` | Cloudflare appends the truth → real client still resolved |
| Multiple forged hops | still resolved correctly |
| Two users behind one NAT | resolved as **distinct** identities |
| Chain shorter than expected | falls back to the socket address, **never** to the forged header |
| No `TRUSTED_PROXY_COUNT` | XFF ignored entirely |
| `CF-Connecting-IP` alone | **does not** establish identity — a direct-to-origin attacker can set it |

Also verified live against a running Bridge: the same simulated client decrements one
rate-limit counter (19999→19998→19997) while a different client gets a **fresh**
counter — proving identities are separate, not collapsed into the POP.

### ⚠ The dangerous mistake

`TRUSTED_PROXY_COUNT=1` behind Cloudflare **and** nginx makes Bridge treat the
Cloudflare POP as the client. **Every user collapses into one identity**; one person's
behaviour then rate-limits or bans everyone. This failure mode has its own test so the
warning is evidence-backed, not folklore.

If you terminate Cloudflare directly onto Bridge with no nginx, use `1`.

## 8. Cache rules — private data must never be cached

Create Cloudflare **Cache Rules** (Rules → Caching):

| Order | Match | Action |
|---|---|---|
| 1 | `starts_with(http.request.uri.path, "/api/")` | **Bypass cache** |
| 2 | `http.request.uri.path eq "/metrics"` | **Bypass cache** |
| 3 | `http.request.uri.path contains "/socket.io/"` | **Bypass cache** |
| 4 | `starts_with(http.request.uri.path, "/dist/")` | Cache, Edge TTL 1 year |
| 5 | `http.request.uri.path eq "/"` or ends with `.html` | **Bypass** (or very short TTL) |

**Defence in depth at the origin:** Bridge now sets `Cache-Control: no-store, private`
and `Vary: Authorization, Cookie, Origin` on every `/api/*` response
(`server/lib/security.ts`), with a regression suite
(`server/tests/edge-cache-safety.test.ts`). Previously these responses carried **no**
`Cache-Control` at all, which would have let any heuristic-caching intermediary serve
one user's authenticated response to another. Static assets and `/uploads/` are
deliberately excluded so they stay cacheable.

**Never cache:** authenticated API, sessions, CSRF, auth, messages, DMs, membership,
permissions, moderation, private media, `/metrics`, health, WebSocket upgrades.

The application shell must not be cached aggressively — a stale shell against a new
API is exactly the version-skew failure the service worker already has to manage.

## 9. WAF

Cloudflare WAF is an **additional** layer. Bridge's own authorization remains the
security boundary; the WAF must never become the only thing standing between an
attacker and your data.

- Enable the **Cloudflare Managed Ruleset**
- Watch for false positives on `/api/` and `/socket.io/` — WebSocket upgrades and JSON
  bodies sometimes trip generic rules
- Deploy in **Log** mode first, review, then move to Block

## 10. Edge rate limiting — must cooperate with Bridge

Two layers with different jobs:

| Layer | Scope | Job |
|---|---|---|
| **Cloudflare** | coarse, IP-based | anonymous floods, scanners, volumetric abuse |
| **Bridge** | account-aware | per-user quotas, shared-IP fairness, abuse escalation |

**Do not** replace Bridge's limiter with Cloudflare IP rules. Bridge's v1.124 fairness
work exists precisely because IP-only limiting punishes everyone behind a NAT.

Suggested edge rules (generous — Bridge does the precise work):

| Path | Suggested |
|---|---|
| `/api/login`, `/api/register` | 20 req / min / IP |
| `/api/2fa/*` | 20 req / min / IP |
| password reset | 10 req / min / IP |
| uploads | 60 req / min / IP |
| everything else | leave to Bridge |

> ⚠ Set these **generously**. A university NAT is one IP with hundreds of legitimate
> users. Too-tight edge rules recreate the exact unfairness Bridge fixed internally —
> and Cloudflare cannot tell those users apart, because it only sees the IP.

Also raise Bridge's own NAT-facing defaults for shared networks — see
`docs/SHARED-IP-POLICY.md` (`MAX_WS_PER_IP`, `RL_SHARED_IP_FACTOR`).

## 11. Bot / challenge policy

**Never** put an interactive challenge in front of:

- `/socket.io/` (WebSocket upgrade — a challenge breaks realtime entirely)
- authenticated background API calls
- media streams
- `/api/health`, `/metrics`
- federation endpoints (`/.well-known/webfinger`, ActivityPub inboxes)

Electron, mobile and federation peers are **not** interactive browsers. A Browser
Integrity Check or CAPTCHA on those paths makes them silently unusable.

Challenges are reasonable for clearly abusive anonymous traffic to HTML routes only.

## 12. TURN / SFU — keep out of the HTTP proxy

**Cloudflare's HTTP proxy does not relay WebRTC media.** Only signalling
(HTTPS + WebSocket) goes through Cloudflare.

```
signalling  browser ──► Cloudflare ──► Bridge          (proxied)
media       browser ──────────────────► TURN / SFU     (DNS-only, direct)
```

- `turn.bridge.example.com` must be **grey cloud (DNS-only)**
- Open the TURN ports directly (commonly 3478 UDP/TCP, 5349 TLS, plus a relay port
  range)
- **Do not** apply the Cloudflare-IP origin firewall to these ports — that rule is for
  the web origin only; applying it to media ports blocks all clients

Cloudflare Spectrum can proxy arbitrary TCP/UDP, but it is a **paid add-on** and is
**not required** to launch. Do not make Bridge depend on it.

Bridge voice remains **experimental** — real TURN/NAT traversal and SFU load are still
unvalidated (see the v1.124 report). Cloudflare does not change that.

## 13. Cloudflare R2 (optional)

Bridge already supports S3-compatible storage; **R2 needs configuration only, no code
change**. Set `CDN_PROVIDER=r2` plus the `R2_*` variables in
`docs/cloudflare.env.example`.

**Security — split public and private:**

| Content | Bucket | Access |
|---|---|---|
| Public assets, emoji, public stickers | public bucket + `cdn.` custom domain | cacheable |
| **Attachments, avatars, private uploads** | **private bucket** | **served through Bridge authorization — never a public bucket URL** |

Bridge has a separate `PRIVATE_STORAGE_PROVIDER` / `PRIVATE_R2_BUCKET` for exactly
this. Putting authorization-required media in a public bucket for convenience defeats
channel permissions entirely.

**The 242 legacy stickers must not be transformed** by any image optimisation product —
their byte-for-byte preservation is a release invariant.

## 14. Metrics and health

- `/metrics` must **not** be publicly reachable. Bridge enforces `METRICS_SECRET`;
  nginx additionally restricts it to private networks. Cloudflare being in front is
  **not** a substitute for either.
- `/api/health` must **never** be cached — it reports live dependency state (503 when
  Redis or PostgreSQL is unreachable, automatic recovery afterwards). A cached 200
  would actively mislead during an incident.
- Scrape Prometheus over the private network, not through the edge.

## 15. Logging and correlation

Every Bridge request already carries a `requestId`, returned as `X-Request-Id`. With
Cloudflare in front you get a second identifier, `CF-Ray`. nginx forwards it.

Correlate: **`CF-Ray` (edge) → `X-Request-Id` (Bridge) → application logs.**

Treat `CF-Ray` as metadata, never as authority. Do not log request bodies or tokens.

Cloudflare Analytics shows edge traffic; it does **not** replace Bridge's own metrics
(message errors, DB, Redis, sockets, permission failures).

## 16. Deployment and rollback

- Hashed assets under `/dist/` are immutable — **no cache purge needed** on deploy
- Purge only the application shell if it changed; **"Purge Everything" should not be
  routine** — it discards the whole edge cache and spikes origin load
- Rollback: redeploy the previous artifact, then purge the shell only
- Bridge rolling deploys are still **unproven** (v1.124) — use a short maintenance
  window and see `docs/RUNBOOK-DEPLOY.md`

## 17. Troubleshooting — telling Cloudflare errors from Bridge errors

| Symptom | Source | Meaning |
|---|---|---|
| **520/521/522/523/524** | Cloudflare | origin unreachable, refused, timed out — Bridge never saw the request |
| **526** | Cloudflare | origin certificate invalid under Full (strict) |
| **1015** | Cloudflare | **edge** rate limit |
| **403 + Cloudflare branding** | Cloudflare | WAF block |
| **429 JSON `{"error":"Çok fazla istek..."}`** | **Bridge** | application rate limit |
| **503 `{"error":"Rate limit service temporarily unavailable"}`** | **Bridge** | Redis unreachable, failing closed |
| **503 `{"error":"Service temporarily unavailable"}` + `Retry-After`** | **Bridge** | dependency outage (e.g. PostgreSQL), retryable |
| **500 `{"error":"Internal server error"}`** | **Bridge** | genuine defect — check logs by `X-Request-Id` |

Rule of thumb: a Cloudflare-branded HTML page is the edge; a JSON body is Bridge.

## 18. Configuration as code

Settings here are few enough that a large IaC framework is not warranted. If you want
reproducibility, use the Cloudflare Terraform provider for DNS records, cache rules
and rate-limit rules, and keep API tokens outside the repo.

**API tokens:** use scoped tokens, never the Global API Key. Separate tokens for DNS,
R2 and cache purge, each with the minimum permission. Nothing in this repository
stores or requires a Cloudflare credential.
