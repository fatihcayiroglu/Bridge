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
| Provider selection + calls | `server/lib/aiProvider.ts` | baseline: first configured of Groq, Gemini, OpenRouter, Ollama; otherwise `rules` (no AI). After P5: `AI_PROVIDER` selects one (`none` = off), plus a self-hosted OpenAI-compatible provider, one total deadline per call |
| Channel context for AI (after P5) | `server/lib/aiContext.ts` | the one permission-checked read of channel content; deleted/system/E2EE excluded; data block in a user turn |
| Streaming answers | `server/routes/ai/streaming.ts` | talks to the providers' streaming APIs itself (OpenAI-style SSE parser shared by Groq and the OpenAI-compatible provider); context comes from `aiContext` |
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
| SH-04 | self-hosting / schema | `scratchpad schema-diff`: the same database after a 1st and a 2nd boot differed — boot re-created `idx_messages_fts` (dropped by migration 027), and user FKs on `oauth_tokens` / `server_boosts` (tables the chain creates) appeared only on the 2nd boot | a fresh install's schema is final after one boot | inline migrations that target chain-created tables ran before the chain; `schema.ts`/inline list still created the superseded FTS index | `076_drop_superseded_fts_index.sql`; the index removed from boot SQL; inline migrations re-run once after the chain applied anything | `SH-FRESH-05` (1st vs 2nd boot: 1265 columns/indexes/constraints identical) failed before | harness `SH-FRESH-05` |
| SH-04b | schema / rollback | CI `verify-migration-rollback --ordered` on the SH-04 change: `011_sprint93_boost_vanity_oauth` ACTUAL_FAILURE and the ordered chain lost `fk_oauth_tokens_user` / `fk_server_boosts_user` (reproduced locally on PostgreSQL 16) | the versioned chain owns its schema: rollback + re-apply converges | SH-04 made boot add the user FKs on chain-created tables in the same boot, but only the inline boot list owned them — no versioned migration did | `077_chain_table_user_fks.sql` owns both FKs (same names; orphan rows removed first, as ON DELETE CASCADE would); 011 classified EXPECTED_DEPENDENCY on 077 | the gate without 077: 011 ACTUAL_FAILURE, chain 2 lost | ordered gate: 61 LOSSLESS, 12 EXPECTED_DEPENDENCY, 0 ACTUAL_FAILURE, chain **0 lost / 0 extra**; harness `SH-FRESH-02/05` (77/77, second boot identical), upgrade 20/20 |
| FED-01 | federation / fresh install | lab `F-FOL-*` on a fresh install: every inbound Follow → 500 (`column "accepted" does not exist`) | a fresh install accepts follows | `COLUMN_MIGRATIONS` ran before `EXTRA_TABLES` created `ap_follows`, so its added columns were skipped on the first boot (803 vs 805 columns, 1st vs 2nd boot) | column migrations re-run after `EXTRA_TABLES` | lab `F-FOL-02/03` fail on `956a96e` | lab `F-FOL-*`; harness `SH-FRESH-05` |
| FED-02 | federation / admin ACL | lab `F-ADV-14`: `POST /api/admin/federation/blacklist` (and whitelist) → 500 | an admin can block/allow a domain | the route wrote `addedAt`/`addedBy`, columns the tables do not have | `FederationRepository.toAclRow` maps onto the real columns; reads accept `createdAt` | `federation-repository-behavior` FED-02 test fails without the mapping | unit test checks written keys against the DDL; lab `F-ADV-14/15` |
| FED-00 | federation / signatures | lab `F-ADV-06`: an activity signed over `(request-target)` only → 202 accepted | host, date and digest must be inside the signature | presence/values were checked, the signed header list was not | `host`, `date`, `digest` required in the signed list; the signed Host must match `INSTANCE_URL` when set | 5 of the new tests fail without the check | `http-signature-cache-and-header-branches` (+7); lab `F-ADV-06` |
| FED-03 | federation / instance peers | lab `F-PEER-03`: every heartbeat ping → 401; key rotation never reached peers | peers authenticate each other; a rotated key is learned | the heartbeat signed `ts+body` into `X-Bridge-Signature` (+ an ignored HMAC); the verifier checked `x-bridge-rsa-sig` over the body only — no Bridge code ever produced what it verified. That body-only form also bound no timestamp, endpoint, sender or receiver and had no replay claim | one signed form (`bridge-peer-sig/1`: version, ts, METHOD, path, sender, receiver, body) sent and verified; single-use claim in the shared replay store; rotation announced to every peer, signed with the previous key (`lib/federationPeerAnnounce.ts`) | round-trip tests fail against the old pair | `httpSignatureV3` (+8), `federation-rsa` (+3), `jobs-federationHeartbeat` (round trip), `federation-peer-announce`; lab `F-PEER-03/06/07` |
| FED-04 | federation / peer registration | lab `F-PEER-04`: registering `https://evil…` whose `/info` claims `url: https://b…` stored evil's key **as B** | the contacted URL is the identity | `POST /peers` stored `remoteInfo.url` | declared url must equal the contacted one (normalised); https in production; a peer must publish an RSA key | old contract test asserted the spoofable behaviour | `federation-peers-discovery-branches` (+6); lab `F-PEER-04/05` |
| FED-05 | federation / domain ACL | lab `F-REV-03`: after B blocked a domain, bob's new posts were still delivered there | a blocked domain receives nothing | `checkFederationACL` ran on inbound requests only | outbound delivery checks the ACL before resolving the actor and again for the resolved inbox host; an unavailable ACL keeps the row queued (never "allow") | 6 of 16 new tests fail with the check removed | `federation-delivery-schedule-acl`; lab `F-REV-03` |
| FED-06 | federation / delivery | code + lab: 4 attempts in ~12.5 min, then dropped with a warn line | an ordinary outage (upgrade, reboot) does not lose activities | `MAX_ATTEMPTS=3`, delays 30 s/2 m/10 m | default schedule 12 steps ≈ 3.5 days with backoff; `FEDERATION_DELIVERY_RETRY_DELAYS_MS` (validated, loud fallback); dead letters at error level without content | the "old ceiling" test fails with 3 steps | `federation-delivery-schedule-acl`; lab `F-PART-*`, `F-RST-*` |
| FED-07 | federation / configuration | `INSTANCE_URL=http://…`, `…/path`, `user:pw@…` accepted silently in production; compose/k8s never set it | invalid identity refuses to boot; unset is visible | no validation | production refuses non-https (loopback http allowed for labs), paths, credentials, query; unset → boot warning; compose/k8s pass `INSTANCE_URL`/`WEBAUTHN_RP_ID` | 7 new env tests | `env-validation` (+8) |
| FED-08 | federation / follow | lab `F-SSRF-06/07`: following an actor on a private address → 200, an outgoing-follow row and a queued delivery that could never succeed (the SSRF guard held: 0 canary connections) | refused up front, nothing stored | the follow route never resolved the target | the actor document is fetched first through the SSRF-guarded client and the outbound ACL and must name an inbox; 422/403/503, the reason is not echoed | route test + 7 unit tests | `federation-social`, `federation-delivery-schedule-acl`; lab `F-SSRF-05..07` |
| FED-09 | federation / latency | lab `F-PART-05`: with one follower hanging, publishing took **8034 ms**; an inbound Follow held the remote's request while its Accept was delivered | publishing is not held by a slow remote | the request awaited the first network attempt | after the durable row is written the request waits at most 1.5 s; the attempt finishes in the background (outcome lands in the queue row) | bounded-wait test | `federation-delivery-schedule-acl`; lab `F-PART-05` (**1520 ms**) |
| FED-10 | federation / key rotation | lab `F-PEER-06`: every `key-update` → 500 `Unknown column name: "keyUpdated"` | a peer stores the announced key | the route wrote a column `federation_peers` does not have; the mock DB accepted any column | column removed; rotation logged | new DDL-column test fails with it | `federation-keys-admin` (DDL check); lab `F-PEER-06/07` |
| AI-01 | AI / prompt-controlled access | `clyde/stream?history=[{"role":"system",…}]` forwarded the system turn to the provider | clients cannot author system turns | history filter accepted any role string | `aiContext.sanitizeHistory`: user/assistant only, bounded | streaming test | `ai-streaming-deep-behavior`; lab `F-AI-06` |
| AI-02 | AI / deletion | soft-deleted rows (`[Mesaj silindi]` + author/time) and system messages went into AI context and the server digest; a summary cached before a deletion was served after it for 5 min | deleted content never reaches a provider or a cached answer | queries lacked `deletedAt: null`; cache key was `channel+limit` | filters in every AI/digest/vector query; E2EE payloads excluded; summary cache key = fingerprint of the exact message set | 2 of 6 route tests fail without them | `ai-route-outage-and-deletion`, `ai-streaming-deep-behavior`; lab `F-AI-02/05/09` |
| AI-03 | AI / error disclosure | streams forwarded `err.message` (e.g. `connect ECONNREFUSED 10.0.0.5:11434`) to clients; existing tests asserted it | generic reason to clients, detail in server logs | — | `aiFailureForClient` | tests inverted | `ai-streaming-deep-behavior`, `ai-provider-boundary`; lab `F-AI-11/12` |
| AI-04 | AI / secrets | the Gemini key travelled as `?key=` in the request URL (two places) | keys never in URLs | — | `x-goog-api-key` header | test inverted | `ai-provider-selection-branches`, `ai-streaming-deep-behavior` |
| AI-05 | AI / prompt injection | channel text by any member was pasted into the **system** prompt | channel text is data | — | delimited data block in a user turn; delimiters unforgeable; a rule in the system prompt | streaming tests | `ai-streaming-deep-behavior`; lab `F-AI-07` |
| AI-06 | AI / self-hosting | self-hosted runtimes limited to Ollama; streaming duplicated provider code | any OpenAI-compatible server; one explicit selector; an off switch | — | `openai-compatible` provider (`AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`); `AI_PROVIDER` (+`none`) | — | `ai-provider-boundary` (13); lab `F-AI-01..14` run against it; `F-AI-14` (`none` with a key set) |
| AI-07 | AI / outage | a call could take 3 × 15 s (+30 s Ollama) plus backoff; summarize/suggest/translate answered 500 when the provider failed | bounded, graceful | per-attempt timeouts only; no catch | `AI_TIMEOUT_MS` total deadline; degraded local summary / canned suggestions / 503; outage answers never cached | deadline + outage tests | `ai-provider-boundary`, `ai-route-outage-and-deletion`; lab `F-AI-11..13` (hanging provider: **6010 ms** at `AI_TIMEOUT_MS=6000`) |
| AI-08 | AI / abuse | `/api/ai/summarize` and `/api/ai/moderate` called the provider without the AI rate limiter | every provider-calling route is limited | — | `limits.ai()` | — | route wiring |

### Test/harness and environment notes

| ID | Class | Observed | Note |
|---|---|---|---|
| E-01 | environment/infra | local `docker build` fails at `apt-get update` (403 from `deb.debian.org`) | this sandbox's containers reach the internet only through an HTTPS-only egress proxy; the image build and the compose clean room run in CI instead. The Dockerfile is not changed for the sandbox |
| H-01 | test/harness | first harness run: PostgreSQL refused to start (`Unix-domain socket path … is too long (maximum 107 bytes)`) | the lab's PostgreSQL sockets live in a short `/tmp/bsh-*` directory |
| H-02 | test/harness | egress check reported PASS in a run where the smoke never seeded (an empty log proves nothing) | the check is BLOCKED unless the dataset was created; a positive control proves the observer records a real connect |
| E-02 | external (historic) | upgrade source `v1.122.0` (the only tagged release): `POST /api/register` → 500 `Cannot read properties of undefined (reading 'username')` on a fresh PostgreSQL install, from the harness client and from a plain request | a defect of that old release, fixed on `main` since. The upgrade evidence uses the previous build of `main` (`956a96e` locally; the PR base / previous `main` commit in CI) — the build every current self-hoster runs |
| H-03 | test/harness | a federation-lab boot failure left PostgreSQL running and blocked the ports for the next run | instances are registered before they start, so cleanup always reaches them |
| H-04 | test/harness | lab `F-PEER-03` passed/failed on a condition registration already satisfies (`verified`, recent `lastSeen`) | the check now requires a ping observed at the receiver's front with 200 and a `lastSeen` that advanced |
| H-05 | test/harness | heartbeat-dependent checks saw no ping after a restart | correct product behaviour: one ping per peer per 5 min cluster-wide (Redis claim). The lab expires the claim (documented time skip); the ping that follows is the real job |
| H-06 | test/harness | AI lab deleted messages via `/api/messages/:id` → 404, so "deleted" canaries were never deleted (and looked like leaks) | the messages router is mounted under `/api/channels` (`DELETE /api/channels/:messageId`, as e2e uses) |
| H-07 | test/harness | AI outage probe hit a cached summary (7 ms) instead of the failing provider; F-AI-09 first asserted "not served from cache" although a cache hit for the identical post-deletion message set is correct | a fresh message precedes the outage probe and the check requires a provider attempt; F-AI-09 asserts the served summary was computed without the deleted message (`messageCount`, `to`) |
| H-08 | test/harness | the federation lab's egress check could pass on an empty log | lab hostnames are recorded (tagged) in the lab; `F-EGR-00` requires that traffic as a positive control |
| H-09 | test/harness | full-suite runs with coverage: 1 failure in 6 runs, `health-schema-readiness` (a P5 batch-1 test, already on `main`) — `not.toMatch(/migration\|schema\|75/i)` matched the body's millisecond `ts` whenever its digits contained "75" | reproduced deterministically by pinning `Date.now()` to `1790873756193`; the check now asserts the exact generic key set and excludes only the clock value; negative control: a body naming `dependency: 'schema'` fails it |
| E-03 | environment | mid-session the sandbox's `/etc/hosts` was reset; the next lab run reported `F-SETUP` **BLOCKED** (not PASS/FAIL) | entries restored, run repeated; CI adds them in the workflow |

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

## Federation evidence

Harness: `scripts/federation-lab/run.mjs`; CI: `.github/workflows/federation-evidence.yml`.

**Topology.**
- **Two installations.** A and B are independent Bridge processes, each with
  its own PostgreSQL, Redis and uploads. They run the production build behind
  TLS fronts at `https://a.bridge.test:57443` and `https://b.bridge.test:57444`,
  signed by a lab CA the installations trust.
- **Hostile remote.** X (`https://evil.bridge.test:57445`) is a remote
  ActivityPub actor ("mallory") with its own RSA key. Every signing parameter
  is under the lab's control.
- **SSRF canary.** `canary.bridge.test` resolves to 127.0.0.1 but is **not** in
  `SSRF_ALLOWLIST`. A raw TCP listener counts every connection made to it.
- **What it is not.** None of this is an in-process mock.

**Statuses.** Only PASS passes; MEASURED values are reported, not judged.

| Scenario | Checks | What it proves |
|---|---|---|
| identity | F-ID-01..04 | instance info + RSA key over HTTPS; WebFinger resolves local, refuses foreign resources; actor documents carry owned keys |
| follow | F-FOL-01..04 (+M1) | signed Follow A→B, B records the follower, B's signed Accept reaches A, duplicate refused (follow → accepted **≈185 ms**) |
| post | F-POST-01..06 (+M1) | public note B→A timeline (**≈45 ms**), non-follower does not see it, followers-only reaches only the follower, exactly one stored copy |
| inbound-lifecycle | F-LIFE-01..05 | remote Accept / Create / Update / Delete processed; another actor cannot edit or delete bob's note |
| adversarial | F-ADV-00..15 | replay, unsigned, actor spoofing, tampered body, stale Date, weak header list (FED-00), duplicate activity id, malformed JSON, missing type, over-long id, 300 kB body (413), private keyId (no fetch), unknown user, admin domain block/unblock (FED-02) |
| ssrf | F-SSRF-01..07 | private addresses by IP and by DNS name: follow, fetch-remote, profile, inbox keyId, peer registration — **0 canary connections**; refused without success or 500; a refused follow stores nothing (FED-08) |
| partition | F-PART-01..06 (+M1, M2) | B queues durably while A refuses; nothing leaks through; delivered exactly once after reconnect (**≈46 s**, 30 s worker tick); a hanging peer holds publishing ≤ **1.52 s** (FED-09); a timed-out delivery is retried and arrives |
| restart | F-RST-01..03 (+M1) | A restarts with deliveries pending; B restarts holding a queued delivery (startup recovery **≈31 s**); sessions and follow state survive |
| peers | F-PEER-01..07 | admins register each other (HTTPS key fetch); non-admin refused; real signed heartbeat accepted (FED-03); a server claiming B's URL is not registered as B (FED-04); key rotation announced, stored, and the next heartbeat under the new key accepted (FED-03, FED-10) |
| revocation | F-REV-01..05 | a domain block stops outbound delivery (FED-05); a removed peer's heartbeat is refused (401); the refused side logs `federation.heartbeat.peer_refused` |
| ai | F-AI-00..14 (+M1) | see AI evidence |
| egress | F-EGR-00..01 | positive control (the run's own lab traffic is recorded), then **0 connections outside the lab** from either installation |

**Local runs on this branch.**
- **Federation scenarios:** 65 PASS, 5 MEASURED, 0 FAIL (`fed-run6`).
- **AI scenarios:** 26 PASS, 2 MEASURED, 0 FAIL (`fed-ai2`).
- **Final full run, all twelve scenarios on one build (`fed-run8`, branch head `0ffd173` + lab fixes):** **81 PASS, 6 MEASURED, 0 FAIL, 0 BLOCKED**.
- **CI run IDs:** recorded with the PR.

## AI evidence

The lab's provider is `scripts/federation-lab/lib/fake-ai.mjs`.
- **Real provider path.** It is a real HTTP server speaking the OpenAI
  chat-completions API (streaming and non-streaming). A reaches it through its
  ordinary provider code: `AI_PROVIDER=openai-compatible`, `AI_BASE_URL`,
  `AI_MODEL`, `AI_API_KEY`.
- **Inspected traffic.** Every request body it receives is recorded and checked.
- **Canaries.** Secrets are unique strings placed in a private channel
  (@everyone denied VIEW_CHANNELS), another server, a DM and a deleted message.
- **No external AI.** No test data goes to a real AI service.

| Check | Result |
|---|---|
| F-AI-01 carol summarises a channel she can read | the provider receives it; **no** canary from hidden places |
| F-AI-02 / F-AI-09 deletion | a deleted message never reaches the provider; after a deletion the summary served was computed without it (2 msgs → 1 msg) |
| F-AI-03 every AI route (summarize, suggest-reply, ask/stream, stream, clyde) aimed at #staff, another server, a DM id | 403/404 |
| F-AI-04 negative leak test | **0** provider requests for all refused calls |
| F-AI-05 server digest | only channels carol can see |
| F-AI-06 prompt + forged `system` history | no hidden data, a single (server-authored) system turn |
| F-AI-07 placement | channel text is a delimited data block in a user turn, never in the system prompt |
| F-AI-08 positive control | the owner's #staff summary does send #staff |
| F-AI-10 secrets | the key reaches the provider (Authorization) and appears in no response, no `/ai/status`, no instance log |
| F-AI-11..13 outage | provider 500: local summary, `degraded: true`, no upstream text; stream: generic error event; provider hanging: bounded at `AI_TIMEOUT_MS=6000` (**6010 ms**) |
| F-AI-14 `AI_PROVIDER=none` on B with a Groq key set | AI off, local fallback, no provider contacted, **0** SaaS connections in B's egress log |

Unit tests:
- `ai-provider-boundary` (13);
- `ai-streaming-deep-behavior` (41, of which 6 new P5 cases);
- `ai-route-outage-and-deletion` (6);
- `ai-provider-selection-branches` (25, the Gemini-key test inverted).

Client bundle: the built `client/dist` contains none of the server secret
variable names (`GROQ_API_KEY`, `AI_API_KEY`, `AP_ENCRYPTION_KEY`,
`JWT_SECRET`, `FEDERATION_SECRET`), and client sources read no environment
variables (`grep`, this branch).

## Capstone

The full lab run is the capstone. In one run it has:
- two installations federating;
- unauthorized activity rejected: the adversarial, SSRF and revocation scenarios;
- interruption and restart: the partition and restart scenarios;
- an AI request using only allowed data, with hidden data never reaching the
  provider: F-AI-01..09;
- a self-host-compatible provider: OpenAI-compatible over loopback;
- no mandatory cloud: F-AI-14, F-EGR-00/01, and the self-hosting `SH-EGRESS-*`.

## Security and adversarial coverage

| Concern | Evidence |
|---|---|
| auth bypass / unsigned / spoofed actor | F-ADV-02, F-ADV-03 |
| replay (AP and instance-peer) | F-ADV-01, F-ADV-07, `httpSignatureV3` replay test, `federation-rsa` middleware replay test |
| signature coverage / stale creds | F-ADV-05, F-ADV-06 (FED-00); signed Host must be this instance |
| revocation | F-REV-03/04 (domain block outbound, removed peer refused) |
| key rotation | F-PEER-06/07 |
| SSRF / DNS → private IP | F-SSRF-01..07 (canary), F-ADV-12 |
| malformed / oversized input | F-ADV-08..11 |
| duplicates / ID collisions | F-ADV-07, F-POST-06, F-PART-04 |
| identity spoofing / privilege escalation | F-PEER-04 (FED-04), F-PEER-02, F-LIFE-05 |
| AI context leakage / permission mismatch | F-AI-01..05, F-AI-09 |
| prompt-controlled access | F-AI-06/07 (AI-01, AI-05) |
| provider credential exposure / secrets in logs or bundles | F-AI-10, AI-04, client bundle grep |
| unsafe defaults | FED-07 (INSTANCE_URL), SH-01 readiness gate, AI off unless configured |
| migration corruption | SH-01, SH-04, FED-01; upgrade 20/20 with data |

## Known limitations (documented, not fixed in P5)

- **Remote DMs** (ActivityPub direct notes) are stored but not shown in Bridge's DM UI.
- **No outbound edits or deletions.** Bridge does not send `Update`/`Delete` for its own notes,
  so edits and deletions on Bridge do not propagate. Inbound `Update`/`Delete` from remotes is
  processed (F-LIFE-03/04).
- **Followers-only notes.** Notes received as followers-only are stored like public ones and
  only shown to followers on the receiving installation (F-POST-04/05). Visibility is enforced
  at read time, not by the stored value.
- **Heartbeat cadence.** One heartbeat per peer per 5 minutes cluster-wide. A peer that misses
  a key-rotation announcement refuses the rotated installation until its admin removes and
  re-adds it (it is logged on both sides).
- **Retry-schedule evidence.** The 3.5-day default schedule is proved by unit tests. The lab
  does not wait a real 15-minute outage.
- **Prompt injection is narrowed, not eliminated.** Only data the requester may read ever
  reaches the model.
- **No per-server AI opt-out.** The off switch is per installation (`AI_PROVIDER=none`).
- **Embeddings are never written.** The pgvector embedding writer has no caller, so semantic
  search uses the keyword/AI fallback.
- **Carried over from P4 (not reopened):** P4 hardware items EXTERNAL/UNVERIFIED; MEDIA-11 and
  long-channel virtualization remain documented limitations.

## Closure bar

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | baseline recorded | PASS | § Baseline (`956a96e`) |
| 2 | federation architecture documented | PASS | § Architecture / Federation |
| 3 | AI architecture documented | PASS | § Architecture / AI, `docs/AI.md` |
| 4 | self-hosting architecture documented | PASS | § Architecture / Self-hosting |
| 5 | two-instance federation journey | PASS | identity, follow, post |
| 6 | auth / trust | PASS | adversarial, peers |
| 7 | unauthorized activity rejected | PASS | F-ADV-*, F-SSRF-*, F-REV-04 |
| 8 | replay / idempotency | PASS | F-ADV-01/07, peer replay tests |
| 9 | partition / reconnect | PASS | F-PART-* |
| 10 | restart | PASS | F-RST-* |
| 11 | revocation | PASS | F-REV-*, F-ADV-14/15 |
| 12 | adversarial input | PASS | F-ADV-08..11, F-SSRF-* |
| 13 | privacy (federation) | PASS | F-POST-03..05, F-LIFE-05 |
| 14 | AI boundary | PASS | `aiProvider` + `aiContext`; F-AI-07 |
| 15 | AI permissions | PASS | F-AI-01/03/05/08 |
| 16 | negative leak test | PASS | F-AI-04 (0 provider requests), F-AI-02/09 |
| 17 | AI outage | PASS | F-AI-11..13 |
| 18 | AI secrets | PASS | F-AI-10, AI-04 |
| 19 | AI self-host mode | PASS | OpenAI-compatible provider in the lab; F-AI-14 |
| 20 | fresh install | PASS | SH-FRESH-01..05, SH-COMPOSE-01..04 |
| 21 | persistence | PASS | SH-RESTART-*, F-RST-03 |
| 22 | config fail-fast | PASS | SH-CONFIG-*, FED-07 env tests |
| 23 | upgrade | PASS | SH-UPGRADE-* (20/20) |
| 24 | backup / restore | PASS | SH-BACKUP-*, SH-COMPOSE-06..11 |
| 25 | dependencies documented | PASS | `DEPLOYMENT_GUIDE.md`, `docs/AI.md`, `.env.example` |
| 26 | no Bridge/SaaS infrastructure dependency | PASS | SH-EGRESS-*, F-EGR-00/01, F-AI-14 |
| 27 | P0–P4 gates green | PENDING | final PR checks |
| 28 | final post-merge QG | PENDING | |
| 29 | final dispatched nightly ran | PENDING | |
| 30 | evidence doc complete | PENDING | updated with run IDs at closure |
