# Federation, AI and self-hosting (P5)

P5 makes three capabilities Bridge already ships work end-to-end under realistic failure
conditions, and records what was proved **where**:

1. Bridge ↔ Bridge federation (ActivityPub + HTTP Signatures, as implemented);
2. AI features that respect Bridge's permission model and run without a mandatory third-party
   or Bridge-operated service;
3. self-hosting that is reproducible from a fresh checkout.

Every result carries one status: **PASS**, **FAIL**, **BLOCKED**, **SKIPPED**, **MEASURED**,
**UNVERIFIED**. Only PASS counts as passing. Every failure is classified as **product defect**,
**test/harness defect**, **environment/infrastructure**, **known documented limitation** or
**external/unverified**.

## Baseline

- `main` at the start of P5: `956a96e3cce486270c21158c1107ee1d952d07a8` (PR #114, the P4 closure).
- P4 carried over: implementation complete, physical-device validation blocked (see
  `docs/P4_MOBILE_NATIVE.md`); not reopened by P5.

## Architecture (from the code, not from the ADRs)

### Federation

Bridge implements **ActivityPub** (ADR-0004), not a custom protocol and not Matrix:

| Piece | Code | Notes |
|---|---|---|
| Actors, WebFinger, inbox/outbox, followers/following, notes | `server/routes/federation/activitypub.ts` | one actor per user: `<INSTANCE_URL>/api/federation/users/<username>` |
| Inbox handlers (Follow, Undo, Create, Update, Delete, Like, Announce, Accept, Reject) | `server/routes/federation/inbox-handlers.ts` | `helpers.ts` is a re-export facade |
| Outbound delivery, signing, durable retry queue | `server/routes/federation/delivery.ts` | `ap_delivery_queue` with lease-based claims |
| User-facing social API (follow, like, announce, timeline, profile) | `server/routes/federation/social.ts` | |
| HTTP Signatures (draft-cavage; `rsa-sha256`/`hs2019`), replay cache, key fetch | `server/lib/httpSignature.ts` | remote key fetch is HTTPS-only and SSRF-guarded |
| Instance (Bridge ↔ Bridge) peers, `/info`, `/key`, `/ping`, `/key-update`, discovery | `server/routes/federation/peers.ts` | ADR-0006 per-instance RSA keys; `x-bridge-*` headers |
| Instance-request verification (RSA only) | `server/lib/httpSignatureV3.ts`, `server/middleware/federationAuth.ts` | |
| Domain allow/deny lists | `server/routes/admin/federation-acl.ts` (`checkFederationACL`) | checked on every inbox request |
| Inbox flood limits | `server/middleware/federationRateLimit.ts` | global + per-peer |
| Peer liveness | `server/jobs/federationHeartbeat.ts` | |
| Outbound HTTP | `server/lib/fetch.ts` + `server/lib/ssrfGuard.ts` | private/loopback/metadata blocked, DNS re-checked at connect, redirects re-checked; `SSRF_ALLOWLIST` is the operator's explicit opt-in |

The supported federated user journey is the ActivityPub one: a user follows a remote actor; the
remote instance accepts; the remote user's public posts are delivered to followers' inboxes and
appear in `GET /api/federation/timeline`; direct notes, edits (`Update`) and deletions
(`Delete`) travel the same way. Bridge servers/channels are **not** replicated across instances;
`/api/federation/servers` only advertises discoverable servers with invite links.

### AI

| Piece | Code | Notes |
|---|---|---|
| Provider selection + calls | `server/lib/aiProvider.ts` | first configured of Groq, Gemini, OpenRouter, Ollama; otherwise `rules` (no AI) |
| Streaming answers | `server/routes/ai/streaming.ts` | talks to Groq / Gemini / OpenRouter / Ollama **directly**, duplicating the provider code |
| Summaries, reply suggestions, translation, moderation, discovery | `server/routes/ai/*.ts` | rules fallbacks where AI is off |
| Semantic search, digest, engagement | `server/routes/semantic.ts` | channel visibility filtered before AI |
| Embeddings | `server/lib/pgvector.ts`, `server/jobs/embedHistory.ts` | OpenAI or Ollama; E2EE content is never embedded |
| Background moderation | `server/jobs/autoModeration.ts` | |

### Self-hosting

| Piece | Where |
|---|---|
| Image | `Dockerfile` (multi-stage, non-root, `node server/dist/index.js`, healthcheck `/api/health/ready`) |
| Stack | `docker-compose.yml` (PostgreSQL 18, Redis 8 `noeviction`, Bridge, backup; nginx/certbot and MinIO as profiles), `docker-compose.prod.yml`, `docker-compose.cluster.yml` |
| Kubernetes | `k8s/` (+ Helm chart) |
| Configuration validation | `server/lib/env.ts` — production refuses to start on missing/weak secrets |
| Schema | boot: `server/db/postgres/index.ts` `initSchema` (base schema + inline migrations, advisory lock); versioned SQL: `server/db/migrations_pg/*.sql` via `server/db/migrate-postgres.ts` |
| Health | `/api/health/live`, `/api/health/ready` (DB, Redis when configured, storage, TURN/SFU when required) |
| Backup / restore | `backup/backup.sh`, `backup/restore.sh`, `backup/verify-backup.sh`, `docs/BACKUP-RESTORE.md` |

## Gap matrix (baseline, before any P5 change)

| Area | Exists | Gap found in the audit (to be proven or disproved by an executable test) |
|---|---|---|
| Two-instance federation evidence | 29 federation test files, all in-process with mocks | no test with two real instances and distinct state |
| Instance peer registration (`POST /federation/peers`) | yes | peer URL is taken from the remote's own `/info` answer, not from the URL the admin entered — candidate identity spoofing |
| Instance-request signatures (`x-bridge-rsa-sig`) | RSA over the body | timestamp, method and path are not signed — candidate unlimited replay with a fresh `x-bridge-ts` |
| ActivityPub inbox signatures | `(request-target)` required, Date ±5 min, Digest checked, signature replay cache | `host`, `date`, `digest` are not required to be **signed** — candidate body/date substitution for weakly signed senders |
| Delivery retries | durable queue, 4 attempts in ~12.5 min, then dropped with a log line | a partition longer than ~12 minutes loses activities silently |
| Federation identity config | `INSTANCE_URL` | not validated; not set by compose or k8s; a production instance silently federates as `http://localhost:3001` |
| AI provider boundary | `aiProvider.ts` + duplicated provider code in `streaming.ts` | no single boundary to observe outbound context; self-hosted runtimes limited to Ollama; no generic OpenAI-compatible endpoint |
| AI permission proofs | unit tests with mocks | no test that observes what actually leaves the server |
| AI outage bounds | per-call timeouts + 3 retries | worst case not bounded as a whole |
| Fresh install schema | boot applies base schema + inline migrations | **SH-01, reproduced** (below) |
| Clean-room install evidence | none automated | no fresh-stack functional smoke |
| Upgrade path | migration chain in CI | no previous-version → current upgrade with data |
| Backup / restore | scripts + docs | never executed by a test |

## Defects

### Product defects

| ID | Area | Observed (repro) | Expected | Root cause | Fix | Negative control | Regression test |
|---|---|---|---|---|---|---|---|
| SH-01 | self-hosting / schema | Fresh PostgreSQL 16 + Redis, `NODE_ENV=production node server/dist/index.js` (the image's own command) on `956a96e`: `/api/health/ready` → 200, but `migrate-postgres status` → **75 of 75 versioned migrations pending**; the log shows `relation "ap_delivery_queue" does not exist`, `relation "ap_follows" does not exist`, `relation "oauth_tokens" does not exist`, `relation "server_boosts" does not exist`, `column "subscription" does not exist` | a fresh install has the complete schema, or refuses to report ready | boot runs only `initSchema`; nothing in the image, compose or k8s runs `migrations_pg`. `DEPLOYMENT_GUIDE.md` stated migrations run automatically at startup | `initSchema` applies the versioned chain inside its existing advisory lock (`db/postgres/versionedMigrations.ts`, shared with the CLI); `BRIDGE_AUTO_MIGRATE=false` opts out; readiness is 503 (`dependency: schema`) while anything is pending | the repro above; `health-schema-readiness` 2/3 fail without the gate | `tests/versioned-migrations.test.ts`, `tests/health-schema-readiness.test.ts`; real PostgreSQL: harness `SH-FRESH-02/03`, upgrade `SH-UPGRADE-*3`; measured by hand: two nodes booting at once on an empty database (one applied 75, the other waited on the lock and applied 0, both ready), opt-out (503 → CLI → 200 without restart) |
| SH-01b | federation / boot order | harness `SH-FRESH-04` after the SH-01 fix: a fresh boot still logged `relation "ap_delivery_queue" does not exist` (warn) | no boot-time error on a fresh install; queued deliveries recovered at startup after an upgrade | the delivery retry worker and its startup recovery started as a side effect of **importing** `routes/federation/delivery.ts` — before `initSchema` | `startFederationDeliveryWorker()` / `stopFederationDeliveryWorker()` called from `runtime.ts` after the schema is ready and on graceful shutdown | new test 2/2 fail against the old module | `tests/federation-delivery-worker-start.test.ts`; harness `SH-FRESH-04` |
| SH-02 | backup / restore | harness `SH-BACKUP-03`: `backup/restore.sh` → `verify-backup.sh: Permission denied`; the backup image shipped neither `restore.sh` nor `verify-backup.sh` | the documented restore runs from a fresh checkout and inside the backup container | `restore.sh` exec'd `verify-backup.sh`, stored in git as `100644` | `bash "$SCRIPT_DIR/verify-backup.sh"`; scripts `100755` in git; backup image ships both (`docker compose exec backup restore.sh <dump>`); `backup.sh` takes the same connection variables as `restore.sh` (container defaults unchanged); restore commands documented in `docs/BACKUP-RESTORE.md` §5a | `scripts/backup-tools.test.js` 3/4 fail against the old scripts | `scripts/backup-tools.test.js` (release-integrity suite, every PR); harness `SH-BACKUP-*`; compose `SH-COMPOSE-06..11` |
| SH-03 | backup / restore | harness `SH-BACKUP-03` after SH-02: `verify-backup.sh` refused a valid 161 KB dump: "Dump PostgreSQL SQL içeriği gibi görünmüyor; restore reddedildi"; reproduced: the check pipeline exits 141 | every valid dump is accepted; opaque data is still refused | `gzip -cd \| head -c 262144 \| grep -Eq …` under `set -o pipefail`: `grep -q` exits at the first match, `head` dies of SIGPIPE, pipefail fails the check — for any dump larger than a pipe buffer, i.e. every real one | the sample is read first (`$(… \|\| true)`), then matched | as SH-02 | as SH-02 |

### Test/harness and environment notes

| ID | Class | Observed | Note |
|---|---|---|---|
| E-01 | environment/infra | local `docker build` fails at `apt-get update` (403 from `deb.debian.org`) | this sandbox's containers reach the internet only through an HTTPS-only egress proxy; the image build and the compose clean room run in CI instead. The Dockerfile is not changed for the sandbox |
| H-01 | test/harness | first harness run: PostgreSQL refused to start (`Unix-domain socket path … is too long (maximum 107 bytes)`) | the lab's PostgreSQL sockets live in a short `/tmp/bsh-*` directory |
| H-02 | test/harness | egress check reported PASS in a run where the smoke never seeded (an empty log proves nothing) | the check is BLOCKED unless the dataset was created; a positive control proves the observer records a real connect |
| E-02 | external (historic) | upgrade source `v1.122.0` (the only tagged release): `POST /api/register` → 500 `Cannot read properties of undefined (reading 'username')` on a fresh PostgreSQL install, from the harness client and from a plain request | a defect of that old release, fixed on `main` since. The upgrade evidence uses the previous build of `main` (`956a96e` locally; the PR base / previous `main` commit in CI) — the build every current self-hoster runs |

## Self-hosting evidence

Harness: `scripts/selfhost/` (README there); CI: `.github/workflows/selfhost-evidence.yml`.

Local run (process platform, this sandbox: Ubuntu 24.04, PostgreSQL 16.13, Redis 7.0.15,
Node 22.22, upgrade source = `956a96e` built): **all PASS** after the fixes above —
`fresh` 4/4 (+1 MEASURED: boot → ready on an empty database ≈ 1.5 s), `smoke` 9/9,
`restart` 9/9 (+1 MEASURED: SIGTERM → exit ≈ 50 ms), `config` 9/9, `upgrade` 20/20 (documented
and boot-only histories), `backup` 13/13, `egress` 2/2. CI run IDs are recorded with the PR.

| Closure item | Evidence |
|---|---|
| 20 fresh install | `SH-FRESH-01..04` (process), `SH-COMPOSE-01..04` (compose, CI) |
| 21 persistence across restart | `SH-RESTART-*` (SIGTERM, exit 0, restart, fresh logins read everything back); `SH-COMPOSE-05` |
| 22 configuration fail-fast | `SH-CONFIG-01..09`: exit ≠ 0, never listened, the message names the variable |
| 23 upgrade path | `SH-UPGRADE-D*` / `SH-UPGRADE-B*`: previous build + data → this build → chain complete → data intact |
| 24 backup / restore | `SH-BACKUP-*` (shipped scripts, empty target, marker, app on restored data); `SH-COMPOSE-06..11` |
| 26 no mandatory external service | `SH-EGRESS-01`: no TCP/TLS connection left the machine during boot, smoke, restart, upgrade and restore (observer preloaded in every app process; `SH-EGRESS-00` positive control) |

## Closure bar

Tracked in [Closure](#closure) once the batches land.
