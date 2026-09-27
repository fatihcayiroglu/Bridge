# PRODUCTION READINESS REPORT — Bridge v1.123

**Baseline:** v1.122.0 (frozen). No commit, no push, no PR.

**Question this pass asked:** *can Bridge be operated as a real service?*

This report states only what was measured. Where something was not executed, it says
so rather than describing the procedure and implying it ran.

---

## A. Scope actually completed

The v1.123 brief covers 58 sections. This pass went deep on a subset rather than
shallow across all of it, because the first section investigated — the E2E skip audit
— immediately produced live production defects, and following them was worth more
than breadth.

**Fully executed and verified**

| Area | § | Outcome |
|---|---|---|
| Request correlation IDs | 9 | Implemented end-to-end; 21 tests |
| E2E skip audit | 26 | All 44 skips + 1 failure enumerated, categorised, investigated |
| Database performance re-measurement | 32 | Live N+1 found, fixed, measured before/after |
| Dependency degradation + chaos | 15, 17, 50 | Redis outage executed; **top-severity defect found and fixed** |
| Defects from real-world validation | 2(F) | 5 production defects fixed |

**Partially executed**

| Area | § | State |
|---|---|---|
| Observability | 10–14 | Correlation implemented and proven; metrics inventoried live; **SLOs deliberately left unset — no production data** |
| Migration safety | 46 | Fresh-install *and* upgrade paths verified for the schema change made here; not a general audit |

**Not executed** — named honestly in §F below.

---

## B. Production defects found and fixed

All five were found by *executing* things rather than reading code. Each was
reproduced live, fixed, and re-verified.

### B1. Forum thread creation returned 500 — always

`POST /api/threads` (forum topic) failed 100 % of the time. Two independent defects
stacked, the first masking the second:

1. `locked` was missing from `pgCollection`'s `ALLOWED_COLUMNS`, so the insert threw
   `Unknown column name: "locked"`.
2. With that fixed, the insert then hit
   `null value in column "parentMessageId" violates not-null constraint` — because a
   forum topic is **channel-rooted** and legitimately has no parent message, while
   the schema declared the column `NOT NULL`.

Fixed by aligning the allowlist with the schema and by relaxing the constraint in
both `schema.ts` (fresh installs) and `migrations.ts` (existing installs).

**Verified:** create → `201` with `parentMessageId: null`; list → returns the thread.
Fresh database built from scratch confirms `parentMessageId` nullable, `locked`
present, `channelId` still `NOT NULL`.

### B2. Podcast settings returned 500 for two fields

`PATCH /api/podcast/:channelId/settings` failed for `language` and `explicit` — same
allowlist drift. `title` (allowlisted) returned `200`, which isolates the cause
exactly. **Verified:** all three now `200`.

### B3. The allowlist had drifted from the schema by a whole generation

Its comment claimed reconciliation against `information_schema`. Measured: **331**
distinct columns in the database, **6** of them absent from the allowlist. Three were
reachable and producing live 500s; three are currently written only via raw SQL and
would have failed silently the moment those paths moved to `pgCollection`.

**Security note:** the protection was **not weakened**. Every added name is a column
that genuinely exists; values remain parameterised. The allowlist is a defence
against unparameterisable *identifiers*, and it was realigned, not loosened.

**Class closed:** `tests/pgcollection-column-whitelist.test.ts` already existed and
already documented this exact failure mode — but it enumerated columns by hand, so it
stayed green while three endpoints 500'd. A new test parses `schema.ts` and
`migrations.ts` and asserts every declared column is allowlisted. Proven
non-vacuous: removing `locked` turns it red naming `locked (schema.ts → threads)`.

### B4. A transient Redis outage bricked the server permanently — **top severity**

`reconnectStrategy` returned an `Error` after 10 retries, which makes node-redis stop
reconnecting **forever**. Measured: Redis stopped → `503` (correct, fail-closed);
Redis restored and verified reachable → **still `503` after 60+ s with no further
reconnect attempts**. Recovery required a process restart.

Because `/api/health` sits behind the same rate limiter, a load balancer would have
evicted every instance and never restored one: a transient dependency blip becomes a
permanent fleet outage.

Fixed by making retries unbounded with a capped interval. Fail-closed rejection
during the outage was deliberately **left unchanged** — failing open would let anyone
who can disrupt Redis switch off every rate limit in the product.

**Verified by re-running the same experiment:** `503` during a 50 s outage, then
**`200` within 3 s, unattended** (26 reconnect attempts, second `redis.ready`).
Guarded by `tests/redis-reconnect-never-gives-up.test.ts`; all 3 tests fail against
the old strategy.

### B5. Measured N+1 on an app-open path

`GET /api/notification-prefs/unread` read a mute preference **per channel**, up to the
200-channel cap. Measured on real PostgreSQL (p50 of 7 samples, identical channel
counts before and after):

| Channels | Before | After |
|---|---|---|
| 10 | 44.9 ms | 29.2 ms |
| 40 | 92.7 ms | 49.6 ms |
| 100 | 207.9 ms | **110.0 ms** |

Marginal cost per channel: **1.81 ms → 0.90 ms**. The fix uses a batch reader that
already existed; the mute *decision* is unchanged and still owned by
`lib/notificationMute.ts`. Fail-closed behaviour is preserved and still asserted.

**Correcting the v1.122.0 report:** it listed a channel-list N+1 (16 ms vs ~1.2 ms
LATERAL) as outstanding. Re-measured: that optimisation is **already in production**
in `MessageRepository.findLastTimestamps`, the historical figures came from a
benchmark, and the method has **no production caller** at all. The real live N+1 was
the one above, in a different file.

---

## C. E2E suite

| | Before | After |
|---|---|---|
| Passed | 442 | **452** |
| Skipped | 44 | **35** |
| Failed | 1 | **0** |
| Flaky | 0 | 0 |

Full detail in [`E2E-SKIP-AUDIT.md`](../E2E-SKIP-AUDIT.md). The headline:

**The stated skip reasons were frequently false.** Nine tests were hard-disabled as
"endpoint not shipped — 404". Verified against the live route table: polls, badges,
scheduled messages, boosts and forum threads were all **shipped and working**; the
tests were calling the wrong URLs. Rather than fixing a path, someone switched the
test off — preserving a green number while five shipped features lost all E2E
coverage, and while forum threads were 500-ing for every user.

Seven of those now run and pass. Two (canvas REST, go-live) were re-verified as
genuinely absent and keep their skips with corrected reasons.

The single pre-existing **failure was not a product defect**: it passes in isolation
and passes when its file runs whole. It is order/state-dependent test flakiness,
reported as such rather than re-run until green.

The 6 plugin tests remain skipped, but the reason changed from a false one ("admin
login failed — environment not ready") to a verified one: an admin user is now
provisioned by the E2E setup, login succeeds, and `GET /api/admin/plugins` still
returns **404** because the API does not exist. The guard now probes with `GET`
(CSRF returns 403 before routing on `POST`, so the tests' own 404 check could never
fire), which makes the skip self-verifying — it switches itself off if the API ships.

---

## C2. Server unit/integration suite

Full run after all changes in this pass:

```
Test Suites: 465 passed, 1 skipped (466 total)
Tests:       8262 passed, 16 skipped (8278 total)
Time:        80.1 s
```

**Zero failures.** This matters because three of the fixes touched shared
infrastructure — `pgCollection`'s column allowlist (used by every repository),
`lib/logger.ts` (used by every module), and `lib/redisAdapter.ts` (used by rate
limiting, presence, IP bans and the Socket.IO adapter).

## D. Readiness matrix

Nothing is marked **PASS** without evidence in this tree.

| Capability | Status | Evidence |
|---|---|---|
| Request correlation / traceability | **PASS** | 21 tests; live `requestId` observed on real rejection logs |
| Structured logging, no secret leakage | **PASS** | pino JSON; correlation adds only `requestId`/`userId`/`socketId` |
| Metrics exposed | **PASS** | 13 application metrics verified live on `/metrics`; cardinality tests exist |
| Redis outage → correct rejection | **PASS** | measured `503`, fail-closed |
| Redis outage → unattended recovery | **PASS** *(after fix)* | measured `200` in 3 s; regression test |
| Schema/allowlist integrity | **PASS** | drift 6 → 0; self-maintaining invariant test |
| Migration safety (this change) | **PASS** | fresh-install and upgrade paths both verified |
| E2E suite green | **PASS** | 452/0/35, 0 flaky |
| Health/readiness semantics | **PARTIAL** | endpoint works and gates the E2E runner; liveness-vs-readiness split not designed |
| SLIs defined | **PARTIAL** | derivable from shipped metrics; no baseline |
| SLOs | **BLOCKED** | **no production data.** Targets deliberately not invented |
| Backup / restore | **BLOCKED** | **not executed.** `backup/backup.sh` exists; no restore was performed, so no RPO/RTO is claimed |
| Load / soak testing | **BLOCKED** | k6 scripts exist; **not run** |
| Cross-browser matrix | **BLOCKED** | Firefox/WebKit projects exist; only chromium was run |
| Voice / Soundboard real-environment validation | **BLOCKED** | not executed |
| Staging environment | **BLOCKED** | no production-like topology was stood up |
| Human penetration test | **N/A** | out of scope by instruction; not claimed |
| Production uptime / availability | **N/A** | **no production deployment exists.** No figure is claimed |

---

## E. What was explicitly not weakened

- Rate limiting still fails **closed** when its authority is unreachable.
- `ALLOWED_COLUMNS` still rejects any identifier not present in the schema.
- No production type was loosened; no `any` was introduced.
- No test was deleted, and no assertion was relaxed to make something pass. The one
  test expectation that changed (`notification-prefs-route`) was retargeted from a
  per-channel mock to the batch mock; its fail-closed assertion is unchanged.
- Permission resolution was **not** refactored. The remaining ~0.9 ms/channel cost in
  the unread path is documented with its measurement instead, because a permissions
  change validated only by a benchmark is not a safe trade under time pressure.

---

## F. Not done — the honest list

The following sections of the brief were **not** executed. They are listed so the gap
is visible rather than buried:

§3–§8 (staging topology, deployment, config-var classification, CI/CD, release
process), §18–§21 (backup strategy, **restore test**, RPO/RTO, non-DB backups),
§22–§25 (secret management, rotation, `SECURITY-TESTING.md`, attack-surface matrix),
§27–§31 (cross-browser, voice/Soundboard staging validation, HTTP and WebSocket
load), §33 (shared-IP socket ban policy), §34–§36 (coverage, test-strict debt,
unreachable-module audit), §37–§44 (error quality, admin visibility, six runbooks,
incident model, beta plan, privacy/retention, storage growth), §45–§48 (zero-downtime
evaluation, migration deployment safety in general, rollback safety, supply chain),
§49 (soak), §51–§56 (full release gates, repackaging, sticker-payload verification,
fresh-extraction verification, the remaining documentation set).

**Nothing in this tree has been repackaged.** `bridge-v1.122.0.zip` and its SHA-256
remain the last built artifact; no v1.123 package was produced, so no package
verification is claimed. `server/.env` (a local development file created for this
pass) is still present and **must be removed before any packaging**.

The highest-value items from that list, in order: the **restore test** (§19 — a
backup that has never been restored is not a backup), **load/soak** (§30, §49 — the
unread measurements above are single-user and prove scaling shape, not capacity), and
**cross-browser** (§27 — only chromium has ever run).

---

## G. Summary

Bridge is **not yet operable as a real service**, and the blocking items are the
unexecuted ones in §F — above all, a restore has never been performed and no load
test has ever been run.

What this pass changed is the confidence level in what *is* there. Five real defects
were found, three of them user-facing 500s and one of them capable of turning a
30-second Redis restart into a permanent fleet outage. None were visible from reading
the code or from a green test suite — every one surfaced by running the system and
distrusting a reassuring number. The audit's most transferable finding is that a
green suite was being maintained by switching off the tests that would have failed.
