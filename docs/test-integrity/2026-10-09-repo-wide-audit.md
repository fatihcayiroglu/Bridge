# Bridge test-integrity audit — skips, vacuous passes and uncollected suites (2026-10-09)

> **Scope.** Every runner the repository owns (server Jest, real-PostgreSQL/Redis/S3
> Jest, client Vitest, Electron, mobile, bot-sdk, release integrity, Playwright E2E) and
> every workflow that runs them. Static skip constructs **and** what each test really
> measured on a real backend. Counting `skip()` call sites is not the same as counting
> skipped tests: both are given.
>
> **Heads.** `main` = `c517364`. E2E figures for the browser matrix come from PR #155
> (`c1a72a9`, main + the Firefox fix). Fixes listed as *closed* are on PR #156
> (`test-integrity/2fa-budget-isolation`).
>
> **Not a closure record for #133.** Items under §6 are documented, not closed.

## Classes

| | Meaning |
|---|---|
| **A** | Platform/config-specific, verified elsewhere (named) |
| **B** | Needs an integration environment (PG, Redis, S3, a bundle, the internet) |
| **C** | Feature not implemented |
| **D** | Fixture / infrastructure bug |
| **E** | The skip or a lenient assertion **hides a real defect or measures nothing** |
| **F** | Stale or invalid contract (route, field or payload the product no longer has) |
| **G** | Never collected or never run by any workflow |

## 1. Real results (`--retries=0`)

| Runner | Result | Skipped | Source |
|---|---|---|---|
| E2E chromium | 527 passed · 0 failed | 0 | CI `c1a72a9`; local on #156: 527 / 0 / 0 |
| E2E firefox / webkit | 27 / 27 passed | 0 | CI `c1a72a9` |
| E2E voice-media · mobile · a11y ×3 | 33 · 6 · 10/10/8 passed | 0 | CI `c1a72a9` |
| E2E WebP-enabled · S3-compatible (RustFS) | 8 · 1 passed | 0 | CI `c1a72a9` |
| Client Vitest | 5403 passed (318 files) | 0 | CI #156 |
| Release integrity (node:test) | 182 passed | 0 | CI #156 |
| bot-sdk Jest | 55 passed | 0 | CI #156 |
| Electron Jest (Linux) | 50 passed | **1** (A, below) | CI #156; Windows job 51/51 |
| Mobile Jest | 127 passed (11 suites) | 0 | CI #156 |
| Real PG/Redis/S3 Jest (`test:pg`) | 156 passed (25 suites) | 0 | CI #156 |
| pgvector · live search | 12 · 16 passed | 0 | CI #156 |
| Server Jest | 12003 passed (623 suites) · 0 failed | 0 pending / 0 todo | local on #156 incl. the voice mount fix |
| Ownership | 1062 test files, 0 unowned | — | `scripts/verify-test-ownership.js` |

Workflows: no `continue-on-error`, no `--passWithNoTests`; `|| true` appears only in cleanup steps.

## 2. Static skip constructs

| File:line | Construct | Class | Evidence / where verified | Status |
|---|---|---|---|---|
| `e2e/tests/2fa.spec.ts` (3 sites) | skip on 429, on setup ≠ 200, on missing 2FA fixture | **E** | see §3 | **closed** (#156) — no skip left |
| `e2e/tests/privacy-lifecycle.spec.ts:58` | skip on login 429 | **E**-risk | login budget is a 2000/min E2E throughput value; a 429 is a runaway loop | **closed** (#156) — fails instead |
| `e2e/tests/webfinger.spec.ts:257` | skip when `/nodeinfo/2.1` 404 ("not implemented") | **F** | implemented (`server/app/setupRoutes.ts`) and advertised by `/.well-known/nodeinfo` | **closed** (#156) — 200 + NodeInfo fields asserted |
| `e2e/tests/sprint83.spec.ts:494` | skip when `/api/docs` 404 ("not enabled") | **F** | `swagger-ui-express` is a runtime dependency, mounted unconditionally | **closed** (#156) — UI + `spec.json` routes asserted |
| `e2e/tests/webp-upload.spec.ts:203` | skip unless the runner's `CDN_PROVIDER` is local | **F** (+ **E**-risk) | the attachment URL is `/uploads/<id>` for every provider; the test also accepted `http…`, the exact public-URL leak the contract forbids | **closed** (#156) — provider-independent exact shape |
| `e2e/tests/webauthn-virtual.spec.ts:55` | chromium only | **A** | CDP virtual authenticator exists only in Chromium | open, legitimate |
| `electron/tests/main.test.ts:274` | `it.skip` unless win32 | **A** | Windows job: 51/51 | open, legitimate |
| `mobile/tests/shell-composition.test.js:56` (4 describes) | `describe.skip` without a built client bundle | **B**, **E**-risk | CI builds the bundle first (127/0 now; the 2026-10-08 ledger recorded 105 passed / 22 skipped at the B2 head) | open — no guard (§6) |
| `mobile/tests/ios-overlay.test.js:38` | `describe.skip` without the iOS template | **B**, **E**-risk | runs in CI today | open — no guard (§6) |
| `server/tests/pg-integration/*.pgtest.ts` (20) | `describe.skip` without `PG_TEST_URL` | **B** | `npm run test:pg` fails closed without `PG_TEST_URL` (`scripts/require-env.cjs`) | guarded |
| `…/chunk-upload-quota-redis`, `presence-reaper-redis`, `redis-cache-invalidation`, `redis-sfu-ownership` | `describe.skip` without `REDIS_TEST_URL` | **B**, **E**-risk | set in CI today | open — **not** guarded (§6) |
| `…/minio-storage-boundary.pgtest.ts:43` | `describe.skip` without `MINIO_TEST_ENDPOINT` | **B**, **E**-risk | set in CI today (RustFS) | open — **not** guarded (§6) |

E2E static skip sites: **8 → 1** — the Chromium-only WebAuthn virtual authenticator (class A).

## 3. Vacuous passes — worse than a skip

A skip is visible; these were green. Found by tracing every lenient status
assertion (`>= 400`, `< 500`, `!= 200`, `if (status === 200)`) to the response it
actually received on a real backend.

| Test | It claimed | It actually measured | Class | Fix (#156) |
|---|---|---|---|---|
| 2FA "invalid OTP is rejected" | wrong code refused | 429 from a budget the whole suite shares from 127.0.0.1 (5 / 5 min, production value); also sent `{token}` while `/verify` reads `code` | **E** | own client address (real socket peer, production-size budget); wrong `code` → 400 "Invalid code", 2FA stays off |
| 2FA "disable without token is rejected" | missing credential refused | the same 429 | **E** | 400 "password required" |
| 2FA "OTP brute force is cut off with 429" | wrong codes evaluated, then cut off | 429 on its first request — nothing evaluated | **E** | exact sequence: limit 5, four wrong codes 400, fifth 429 + Retry-After, then even the correct code 429 |
| 2FA "status endpoint returns the 2FA state" | the state | `/api/me` never returns `twoFactorEnabled`; the only assertion was inside `if` | **F** | `GET /api/2fa/status` |
| profile "wrong current password" / "weak new password" | password-change validation | 404 — `/api/me/change-password` does not exist (the route is `/api/change-password`) | **F** | real route, exact reasons, original password still signs in |
| messaging "empty message" / "> 2000 chars" | send validation | 404 — there is no REST send; the write path is Socket.IO | **F** | `message:send`: `EMPTY_MESSAGE` / `MESSAGE_TOO_LONG` for THIS ackId, 2000 accepted, nothing persisted |
| voice "unauthorized join" / "mute-deafen" / "member list" | the REST voice API | 404 — a **product bug**: the router was mounted under `/servers`, so the documented `/api/channels/:id/voice-state|voice-members` did not exist | **E** | **server fix** (mount at `/channels`) + `voice-route-mount-contract.test.ts` (red → green) + exact E2E contract |
| voice "voice channel cannot be deleted" | channel delete authz | the MESSAGE delete route (`DELETE /api/channels/:id` → "Message not found") | **F** | real route: member without MANAGE_CHANNELS → 403, unknown id → 404 |
| link-preview SSRF / scheme ×5 | refusal | `!= 200` / `>= 400` — a missing route would pass | **E**-risk | product body `404 {error:'Preview not available'}` |
| messaging "XSS message is sanitized" | stored content has no `<script>` | 404 from the non-existent REST send; the assertion sat inside `if (status < 400)` and never ran. Premise also stale: content is RAW text by contract (Final21 phase 16) | **E** + **F** | Socket.IO send; stored verbatim; rendered in Chromium as visible text, no `script`/`img` element, handler never runs |
| sprint83 "stage join requires auth" | join authorization | 404 from a non-existent `…/voice/join`, accepted as proof | **F** | Socket.IO `voice:join` by a non-member → `voice:join-rejected` FORBIDDEN |
| attachment URL (webp-upload) | URL shape | skipped unless the runner's CDN_PROVIDER was local; accepted `http…` (a public-URL leak) | **F** + **E**-risk | `^/uploads/<id>$` for any provider |
| auth "invalid e-mail login" | credential check | 400 from schema validation — it sent `{email}`, login reads `username` | **F** | unknown username from its own address → 401 (failed logins feed the per-IP CAPTCHA counter) |
| auth "empty password" | empty password refused | the same "username is required" 400 | **F** | username + empty password → 400 naming the password |
| upload "too large file (413)" | size limit | 400 from the type filter (`application/octet-stream`) before size was checked | **F** | 30 MB `image/png` → 413 |

What the link-preview E2E cannot prove, by design: from the outside a refused private
address looks like an unreachable one. The guard itself is proven in
`server/tests/fetch-ssrf.test.ts` (private / loopback / metadata / IPv6 literals, DNS
rebinding, public-IP positive control) and `link-preview-cache-tiers.test.ts`
(`javascript:` / `data:` / `file:` refused without any request).

Side effect closed with the 2FA isolation: every 429 counts toward the 10-violation
automatic **IP ban** (`RL_HTTP_AUTO_BAN_THRESHOLD`). The old file produced three
`twoFactor` violations per run on 127.0.0.1; a few quick local re-runs could ban the
whole suite's address. The isolated addresses take their own two violations.

### Route-missing sweep (every response that was the server's own "route not found")

Network-traced full chromium project on #156 head `6518bac`: **527 passed**. (A
first attempt with `snapshots: false` recorded no network at all and is not
counted — Playwright only captures HAR entries with snapshots on.)

| Response | Tests | Disposition |
|---|---|---|
| `GET /api/admin/plugins`, `POST /api/admin/plugins/load` | plugins.spec | **intentional**: asserts the runtime code-loading admin API is absent |
| `POST /api/channels/<id>/messages` | messaging XSS | **fixed** (above) |
| `POST /api/channels/<id>/voice/join` | sprint83 stage join | **fixed** (above) |
| 27 stylesheet paths at the site root (`/tokens.css`, `/modules/*.css`), 184 requests | 7 a11y.flows + 1 cross-browser test | **open**: the same files load fine from `/css/…`; order-dependent (0 in an isolated a11y.flows run), no assertion depends on them. Something resolves `css/style.css`'s `@import`s against `/` in some runs — to be traced |

## 4. Never collected or never run (G)

| Item | Content | Status |
|---|---|---|
| Playwright project `visual` — `visual-review.spec.ts` | 9 assertions incl. UX-6 compact-row rhythm and theme application; the rest are screenshots for human review | **no workflow runs it** |
| `visual` — `overlay-family.spec.ts`, `perf-probe.spec.ts` | 0 assertions (capture tools) | no workflow; not tests in the contract sense |
| Playwright project `perf` — `perf-benchmark.spec.ts` | asserts only that samples were taken | no workflow; a measurement tool, not a gate |

## 5. Priority debts from the brief

| Debt | Finding | Status |
|---|---|---|
| 429 skips (2FA, privacy lifecycle) | 2FA: shared per-IP budget, three vacuous passes; privacy: unreachable 429 under the E2E budget | **closed** by isolation; no production or E2E limit changed (`RL_2FA_*` still 5 / 5 min, asserted via `X-RateLimit-Limit`) |
| `/nodeinfo/2.1`, Swagger UI | both implemented | **closed** — asserted, not skipped |
| Storage | local: E2E default; S3-compatible: proven against **RustFS** in CI (`remote-storage.spec.ts`, `minio-storage-boundary.pgtest.ts`) | **Cloudflare R2 is not directly verified anywhere.** RustFS evidence is S3-API evidence, not R2 (nor MinIO-vendor) evidence |
| Windows-only Electron test | split kept | runs and passes on the Windows job |
| Plugins (#153) | runtime, compiled-server loading of bundled plugins, wildcard dispatch and unregister isolation tested on the real registry; the runtime code-loading admin API asserted **absent** | covered |
| Virtual scroll (#154) | not implemented; four skips replaced by two paging tests of the shipped history; the decision is recorded (`docs/P4_MOBILE_NATIVE.md`, closure item 17: "virtualisation is not added") | coverage of an unbuilt feature is **not** claimed |

## 6. Open — documented, not closed

1. **Zero-skip guard (P1).** `test:pg` fails closed only on `PG_TEST_URL`; the five
   Redis/S3 suites and the mobile bundle suites fall back to `describe.skip` if CI ever
   loses their env or build step, and the job would stay green. Proposed: fail the step
   when its Jest JSON reports pending tests.
2. **Visual project (G).** Run `visual-review.spec.ts`'s asserting tests in a workflow,
   or move UX-6 and theme application into the chromium project.
3. ~~Remaining lenient assertions.~~ **Closed in #156** (`26ebfed`): 20 sites in 9
   specs are now pinned to the traced status and body. Three of them never measured
   their claim (table in §3); the other 17 got the right refusal but also accepted
   429/5xx. The SVG ones are 422 `SVG_XSS` from the content scanner, which also
   quarantines the file; the route's `SVG_UNSAFE` is the layer behind it. 0
   `>= 400` / `< 500` status assertions remain in `e2e/`.
4. **WebAuthn step-up proof** is not sent in `webauthn-virtual.spec.ts` because the
   browser shares 127.0.0.1's `twoFactor` budget with the global setup.
5. **Conditional-only assertions — swept; 7 closed, 3 open.** An AST sweep of
   `e2e/tests` (TypeScript compiler API) listed every test whose assertions all sit
   inside an `if` / ternary / `&&` / `catch`, counting `body`/`html` visibility as no
   assertion. Tests with no `expect` at all are either helper-asserting
   (`expectNoA11yViolations`, `expectRefused`) or the `visual`/`perf` capture tools in §4.

   | Test | What it measured | Status |
   |---|---|---|
   | channels "server create modal opens" | nothing: none of its selectors exist in the client; both checks inside `if (count > 0)` | **closed** (`12f08a1`): real rail button → EmptyServerStart modal dialog |
   | channels "channel list is visible" | only `body` | **closed** (`12f08a1`): own server → `general` in `.channel-list-host` |
   | messaging "composer is visible" | only `body`; no channel was opened | **closed** (`5808014`): own channel → `#msg-input` visible + editable |
   | a11y.flows "high contrast" | nothing: the reload after `emulateMedia` dropped the opened channel | **closed** (`12f08a1`): no reload; `forced-colors` matches; composer + send visible |
   | link-preview POST without URL | only if 200 | **closed**: exactly `200 {previews: []}` (no network needed) |
   | webp-upload GIF | only if 200 | **closed**: exactly 200 |
   | web-push vapid key / test push (×3) | whatever the runner's env held | **closed**: E2E server pins VAPID off (`E2E_VAPID_*` overrides); exact 503. Negative control: with keys set, 3 fail (200). Configured path: `server/tests/webpush.test.ts` |
   | a11y.flows "notification area has role/aria-live" | only if a toast happened to be visible; typing in Ctrl+K raises none | **open**: no deterministic toast trigger found in the flow. The role contract (`status`/`alert`, `aria-live`) is proven in `client/tests/toast-host.test.ts` |
   | link-preview GET "expected fields" / POST "max 3 URLs" | only if a preview came back, i.e. if the runner has outbound internet | **open, class B**: a local fixture can't stand in, because the SSRF guard refuses loopback/private targets by design. Route shape and the 3-URL cap are proven in `server/tests/linkPreview.test.ts` and `link-preview-cache-layers.test.ts` |

   Limits of the sweep: an assertion inside a loop over a possibly empty collection is
   not flagged, and a weak unconditional assertion other than `body`/`html` visibility
   still counts as one.
6. **Root-relative stylesheet 404s** (route-missing sweep above).
7. **#156 CI** runs the changed specs plus the security/smoke suites; the full browser
   matrix for it is the nightly run.
