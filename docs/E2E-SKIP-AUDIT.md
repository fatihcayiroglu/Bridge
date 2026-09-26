# E2E SKIP AUDIT — Bridge v1.123

**Scope:** every skipped Playwright test in the `chromium` project, enumerated,
categorised, and investigated.

**Baseline run (v1.123 start, before this audit):**

```
stats: { expected: 442, skipped: 44, unexpected: 1, flaky: 0 }   // 487 total
```

The v1.123 prompt asked for "ALL 41". The measured number in this tree is **44**
skipped plus **1** failure. This document covers all 45.

---

## 0. Categories

| Code | Meaning |
|------|---------|
| **A** | Legitimate environment/config gate — the feature is off in this environment by design. |
| **B** | Optional external integration not configured (third-party provider). |
| **C** | Genuinely not shipped — no such endpoint/capability exists in the product. |
| **D** | Test-infrastructure limitation (missing fixture, wrong architecture assumption). |
| **E** | **Hidden defect** — the skip reason is false and it was concealing shipped code or a real bug. |

---

## 1. Headline result

The single most important finding of this audit is that **the stated skip reasons
were frequently untrue**.

Nine tests in `features.spec.ts` were hard-disabled with `test.skip(true, 'SEVK
EDİLMEDİ: … 404')` — "not shipped, endpoint returns 404". Verified against
`server/app/setupRoutes.ts` and against the running server:

| Test's claim | Measured reality |
|---|---|
| `/api/polls` 404 — polls not shipped | `POST /api/channels/:cid/polls` → **200**, full poll object |
| `/api/badges` 404 — badges not shipped | `GET /api/badges/definitions` → **200**, real definitions |
| `/api/scheduled-messages` 404 (×2) | `POST /api/scheduled` → **200**; past date → **400 "sendAt must be a future date"** |
| `/api/boost` 404 — boost not shipped | `GET`/`POST /api/servers/:sid/boosts` → **200** |
| `/api/channels/:id/threads` 404 (×2) | `POST /api/threads` / `GET /api/threads/channel/:id` exist |
| Canvas clear 404 | Correct to skip — but the reason is wrong: canvas is **socket-only**, not "unshipped" |
| Go-live 404 | **Confirmed genuinely absent** |

Seven of those nine tests now run and pass. The tests had simply been calling the
wrong URLs; rather than fixing the path, they were switched off, and the suite's
green number was preserved while five shipped features lost all E2E coverage.

### 1.1 Three real production defects were hiding behind those skips

Pointing the forum-thread test at the real endpoint immediately produced a **500**.
Investigating that produced three separate defects — all reachable by any user:

| # | Defect | Symptom | Fix |
|---|---|---|---|
| 1 | `locked` missing from `pgCollection` `ALLOWED_COLUMNS` | `POST /api/threads` (forum topic) → **500** every time | Column added |
| 2 | `language`, `explicit` missing from the same allowlist | `PATCH /api/podcast/:channelId/settings` → **500** | Columns added |
| 3 | `threads."parentMessageId"` was `NOT NULL` | Forum topics are **channel-rooted** and have no parent message → **500** even after fix #1 | `DROP NOT NULL` migration + schema change |

Defect 3 was only visible *after* defect 1 was fixed — the first error masked the
second. Forum thread creation has therefore been **completely non-functional**, and
the only test that would have caught it was disabled with a false reason.

#### Root cause of #1 and #2 — a stale invariant, not a typo

`ALLOWED_COLUMNS` is a SQL-injection defence (a column name cannot be a bind
parameter, so an allowlist is mandatory). Its comment claimed it had been
reconciled against `information_schema.columns`. Measured against the live schema:

```
DB distinct columns : 331
allowlist entries   : 329
REAL COLUMNS MISSING FROM ALLOWLIST (6):
  bridgeMessageId   -> crosspost_log
  crosspostedAt     -> crosspost_log
  explicit          -> podcast_settings
  language          -> podcast_settings
  lastPlayedAt      -> soundboard_user_stats
  locked            -> threads
```

Three of the six (`locked`, `language`, `explicit`) were reachable through
`pgCollection` and produced live 500s. The other three are currently written only
through raw parameterised SQL, so they did not fail — but they would fail silently
the moment those paths moved to `pgCollection`.

**The protection was not weakened.** Every added name is a column that genuinely
exists in `information_schema`; values remain parameterised. The allowlist was
brought back into alignment with the schema, not loosened.

#### The class is now closed by an invariant, not by six more assertions

`tests/pgcollection-column-whitelist.test.ts` already existed and already documented
this exact failure mode — but it enumerated columns **by hand**, so it only ever
caught the columns somebody remembered to write a test for. It was green while three
endpoints were returning 500.

A new test in that file parses `schema.ts` (`CREATE TABLE` bodies) and
`migrations.ts` (`ADD COLUMN`) and asserts every declared column is allowlisted. Any
future column added without updating the allowlist now fails immediately, even if
nobody writes a test that touches it.

Verified non-vacuous: removing `locked` from the allowlist turns the suite red with
`locked (schema.ts → threads)`.

---

## 2. Full inventory — all 44 skips

### `features.spec.ts` — 11 skipped → **4** (7 recovered)

| Line | Test | Original reason | Cat | Outcome |
|---|---|---|---|---|
| 51 | forum kanalında thread açılabilir | "threads endpoint 404" | **E** | **Fixed & passing** — found defects 1 & 3 |
| 64 | thread listesi alınabilir | "threads endpoint 404" | **E** | **Fixed & passing** |
| 81 | anket oluşturulabilir | "/api/polls 404" | **E** | **Fixed & passing** |
| 154 | canvas temizlenebilir | "canvas clear 404" | **C** | Still skipped — reason corrected to "socket-only architecture" |
| 289 | boost isteği gönderilebilir | "/api/boost 404" | **E** | **Fixed & passing** (path was singular, real route plural) |
| 324 | rozet tanımları listelenebilir | "/api/badges 404" | **E** | **Fixed & passing** — the path was *already correct*; only the skip was wrong |
| 346 | zamanlanmış mesaj oluşturulabilir | "scheduled-messages 404" | **E** | **Fixed & passing** |
| 373 | geçmişe ait sendAt reddedilir | "scheduled-messages 404" | **E** | **Fixed & passing** — now genuinely asserts the past-date rejection |
| 389 | go-live oturumu başlatılabilir | "/api/golive 404" | **C** | Still skipped — **verified**: no `golive` or `go-live` mount exists |
| 414 | ⌘K komut paleti açılır | "UI_BASE_URL not set" | **A** | Legitimate — UI-only gate |
| 428 | Escape komut paletini kapatır | "UI_BASE_URL not set" | **A** | Legitimate — UI-only gate |

Additional correctness fix found while unskipping: `POST /api/scheduled` requires
`sendAt` as an **ISO string** (`typeof sendAt !== 'string'` → 400) and requires
`serverId`. The original test passed a raw epoch number.

Result: `23 passed, 4 skipped` (was 16 passed, 11 skipped).

### `plugins.spec.ts` — 6 skipped → 6 skipped, **reason corrected**

| Line | Test | Original reason | Cat |
|---|---|---|---|
| 73, 99, 120, 159, 216, 258 | plugin load/list/hook/emitToAll/rate-limit/unload | "Admin giriş yapılamadı (401) — ortam hazır değil" | **E → C** |

The stated reason blamed the environment. Both halves were wrong, and the first half
masked the second:

1. **No admin user was ever provisioned.** The E2E setup created five ordinary users
   and no administrator, so `POST /api/login` as `admin` returned 401 and every test
   skipped before reaching the subject under test. Fixed: `global.setup.ts` now
   provisions one (`ensureAdminUser`). Admin authority is the `users.isAdmin`
   **database** flag — `middleware/auth.ts` reads it from the DB and a token claim
   deliberately carries no authority — so the user is registered through the normal
   API and the flag is then set directly. Guarded: it does nothing when
   `NODE_ENV=production` or when `DATABASE_URL` is unset, so it can only ever touch a
   disposable staging database.
2. **With a real admin, the API still does not exist:** `GET /api/admin/plugins` →
   **404**. No source file in the tree mounts it.

The tests' own `status() === 404` guard never fired, because for a `POST` the CSRF
layer returns **403 "CSRF token missing"** *before* routing — the 404 is never seen.
The guard now probes with `GET`, which CSRF does not intercept, so the skip is
self-verifying: if the plugin admin API is ever shipped, these six tests switch
themselves back on.

This is a genuine coverage gap worth naming: plugin load/unload executes arbitrary
code, and it has **no** E2E coverage — because it has no HTTP surface at all.

### `messaging.spec.ts` (5) and `offline-queue.spec.ts` (5) — **D**, legitimate

| File | Lines | Reason |
|---|---|---|
| messaging | 30, 47, 80 | "GEÇERSİZ MİMARİ: REST gönderim ucu yok" — superseded by `message-actions.spec.ts` (Socket.IO `message:send`) |
| messaging | 93, 113 | "Mesaj fixture gerekli" — cascade from the three above |
| offline-queue | 40, 63 | Same architectural supersession |
| offline-queue | 101, 113, 187 | "Test fixture hazır değil" / empty message list — cascade |

**Verdict: correctly skipped.** Bridge sends messages over Socket.IO, not REST; the
canonical coverage genuinely lives in `message-actions.spec.ts`, and these skip
annotations name it. The five cascading fixture skips exist only because their
sending counterparts are skipped. Not a coverage hole — the journeys are covered
elsewhere.

### `sprint83.spec.ts` — 5, **C/D**

| Line | Test | Reason | Cat |
|---|---|---|---|
| 74 | marketplace seed bot (`bridge-music`) | Seed data absent in this install | **A** |
| 122, 163 | `POST /api/bots/marketplace` | Route not shipped | **C** |
| 188 | duplicate id → 409 | Fixture cascade from the above | **D** |
| 352 | Draw Together in activity list | `/api/activity` absent — socket-only | **C** |

`/api/activity` re-probed in v1.123: **404**. Confirmed.

### `virtual-scroll.spec.ts` — 4, **C**, legitimate

Lines 78, 91, 112, 154 — `window._bridgeVS` exists only as a `globals.d.ts` type
declaration; the product does not virtualise the message list. The skip reasons are
accurate. These should stay skipped until virtualisation is actually implemented;
they are a specification of unbuilt work, not a coverage gap in shipped code.

### `a11y.flows.spec.ts` — 3 skipped + **the 1 failure**

| Line | Test | Cat | Outcome |
|---|---|---|---|
| 215 | Kanal ayarları modalı — focus trap & Esc | **D** | **Now passing** |
| 259 | Sunucu ayarları modalı — genel A11Y | **D** | **Now passing** |
| 299 | Emoji picker — klavye navigasyonu & ARIA grid | **D** | **Now passing** |
| 161 | Kanal listesi — Tab, odak, Enter | — | **The 1 failure. Not a product defect.** |

These are conditional skips that fire when the required UI element is not present.
Running the whole file against a properly seeded account: **10 passed, 0 skipped,
0 failed.**

The single failure (`locator.waitFor: Timeout 10000ms exceeded` waiting for
`[aria-label^="Kanal: "]`) **passes in isolation** and passes when the file is run
whole. It is therefore **order/state-dependent flakiness**, not a product bug: the
account state that the test needs is created by other tests. Reported honestly as a
test-isolation weakness rather than silently re-run until green.

### Remaining singles

| File | Line | Reason | Cat | Verdict |
|---|---|---|---|---|
| `2fa.spec.ts` | 115 | "2FA kullanıcı credential eksik" | **D** | Needs a seeded 2FA-enrolled user; genuine fixture gap |
| `invites.spec.ts` | 172 | "Bob zaten katılmış olabilir" | **D** | Order-dependent — skip masks a real 403 assertion. Worth a dedicated non-member fixture (`carol`). |
| `swagger.spec.ts` | 20 | "Swagger JSON ucu yok — 404" | **C** | Confirmed absent |
| `webp-upload.spec.ts` | 60 | `WEBP_CONVERT` not enabled | **A** | Correct config gate |
| `webp-upload.spec.ts` | 167 | R2 CDN not configured | **B** | Correct optional-integration gate |

---

## 3. Summary

| Category | Count | Meaning |
|---|---|---|
| **A** — environment/config gate | 5 | Correct as-is |
| **B** — optional integration | 1 | Correct as-is |
| **C** — genuinely not shipped | 13 | Correct to skip; several reasons corrected |
| **D** — test-infrastructure limitation | 17 | Mostly correct; 3 a11y now pass, 2 flagged for fixtures |
| **E** — hidden defect / false reason | 8 | **7 recovered and passing; 1 (plugins ×6) reclassified to C with a truthful, self-verifying guard** |

**Net effect**

- Tests recovered from false skips: **7** (now passing)
- Previously-skipped a11y tests now passing: **3**
- Production defects found and fixed: **3** (all 500-level, all user-reachable)
- Skip reasons corrected from false to verified: **17**
- The one "failure" reclassified: **test-isolation flakiness, not a product defect**

**What did not change:** no test was deleted, no assertion was weakened to make
something pass, and no security control was relaxed. The two remaining hard skips in
`features.spec.ts` (canvas, go-live) were each re-verified against the live route
table before their reasons were rewritten.

---

## 4. Recommended follow-ups (not done here)

1. **Plugin admin API has no HTTP surface.** Six tests describe endpoints that do
   not exist. Either ship `/api/admin/plugins*` or delete the spec — leaving it
   skipped indefinitely is the situation this audit exists to prevent.
2. **`invites.spec.ts:172`** — replace the unconditional "Bob may already have
   joined" skip with a guaranteed non-member fixture so the 403 is actually asserted.
3. **`2fa.spec.ts:115`** — seed a 2FA-enrolled user in `global.setup.ts`.
4. **Test isolation** — `a11y.flows.spec.ts:161` depends on account state created
   elsewhere. It should create its own server/channel in `beforeAll`.
5. **Virtual scrolling** — four tests specify behaviour that was never built. Decide:
   implement, or remove the spec and the `globals.d.ts` declaration.


---

# ADDENDUM — Final release closure pass

The audit above reduced skips from 44 to 35. The release-closure pass then attacked
the remaining *actionable* debt (category D). Legitimate A/B/C skips were left alone —
forcing them to zero would mean testing features that do not exist.

## What changed

| Suite | Before | After | What was done |
|---|---|---|---|
| `a11y.flows.spec.ts` | 3 skipped, 1 order-dependent failure | **10/10 pass, 0 skipped** | Suite now provisions its own server + text channel in `beforeAll`. It had been relying on state created by other tests. |
| `invites.spec.ts` | 1 skipped (a stub that made no request at all) | **10/10 pass** | Used `carol`, the fixture documented as the guaranteed non-member, and asserted the real `403` **plus** that the response body leaks no invite code. |
| `2fa.spec.ts` | login test skipped ("credential missing") | **runs and passes** | `global.setup.ts` now enrols a real 2FA user, generating TOTP with the product's own algorithm (base32 + HMAC-SHA1, 30 s step) — **no new dependency**. |

## The 2FA test found a wrong test, and confirmed correct product behaviour

Once the fixture existed the test finally ran — and failed. It expected
`200`/`403` with a `requires2FA` field. The measured contract is:

```
POST /api/login  (2FA-enabled user)
→ 202 {"requiresTwoFactor": true, "tempToken": "..."}
```

**No access token is issued.** The product is correct: 2FA is not bypassable with
username + password. The *test* had been written against an assumed contract and,
because it never ran, the mismatch went unnoticed.

The assertion was rewritten to lock the real security property, which is stronger than
what was there before:

- status is exactly `202`
- `requiresTwoFactor === true`
- a `tempToken` is issued
- **`token` and `accessToken` are both absent**

## Incidental finding — auto-ban escalation from one user's failed 2FA attempts

While debugging the 2FA fixture, repeated `/api/2fa/setup` calls exceeded the
`twoFactor` limit (5 per 5 minutes). That escalated to a **whole-IP HTTP ban**:

```
event=ratelimit.auto_ban.applied
"Otomatik ban: HTTP rate limit (twoFactor) 10x aşıldı"
remainingSeconds: 426
```

Every endpoint then returned `403` for ~10 minutes — `/api/health` excepted, which
correctly stayed `200`.

The escalation is working as designed against a single abuser. Behind NAT it is a
different story: **one person fumbling their 2FA enrolment can ban an entire
school or office for ten minutes.** This is recorded in `CONFIGURATION.md §4`
alongside the measured 10-sockets-per-IP ceiling, and is the strongest evidence yet
that the shared-IP policy needs an account-aware design rather than a bigger number.

## Remaining skips — final classification

| Suite | Count | Category | Release risk |
|---|---|---|---|
| `messaging.spec.ts` | 5 | **D** — Bridge sends over Socket.IO, not REST; canonical coverage is `message-actions.spec.ts`, named in each annotation | **None** — journeys covered elsewhere |
| `offline-queue.spec.ts` | 5 | **D** — same architectural supersession + fixture cascade | **None** |
| `plugins.spec.ts` | 6 | **C** — admin plugin API returns 404; guard is self-verifying and re-enables if it ships | **Low** — nothing to break; but plugin load executes arbitrary code and has zero E2E coverage because it has no HTTP surface |
| `virtual-scroll.spec.ts` | 4 | **C** — `window._bridgeVS` was never implemented | **None** — specification for unbuilt work |
| `sprint83.spec.ts` | 5 | **A/C/D** — marketplace seed absent; `POST /api/bots/marketplace` and `/api/activity` not shipped | **None** |
| `features.spec.ts` | 4 | **A/C** — canvas is socket-only; go-live not shipped; 2 UI tests gated on `UI_BASE_URL` | **None** |
| `webp-upload.spec.ts` | 2 | **A/B** — `WEBP_CONVERT` off; R2 not configured | **None** |
| `swagger.spec.ts` | 1 | **C** — swagger JSON not shipped | **None** |
| `2fa.spec.ts` | up to 3 | **A** — `twoFactor` rate limit (5 / 5 min) consumed by fixture enrolment; the tests already tolerate `429` deliberately | **None** — the protection is correct |

**Zero unexplained skips. Zero hidden critical-journey skips.** Every remaining skip
names a verified reason, and each was re-checked against the live route table during
this pass rather than trusted from its annotation.
