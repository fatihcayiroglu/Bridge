# Bridge — engineering checkpoint for handoff (Claude Code → Codex)

Written 2026-10-09 ~23:50 UTC. Repository: `fatihcayiroglu/Bridge`. Everything below is either a
fact checked at that time (SHAs, CI conclusions) or a result read from a local log. Anything not
run is marked **NOT RUN / UNVERIFIED**. Nothing here has been merged; `main` was not touched.

---

## 1. Exact state

| Ref | SHA | Notes |
|---|---|---|
| `origin/main` | `c517364b9289d13e16101a30d080ca51125971a5` | unchanged during this work |
| PR #155 `test-integrity/integrated-audit` | `c1a72a9a88e85cf4408fa7d8cd82453949cba710` | Draft · mergeable `clean` |
| PR #156 `test-integrity/2fa-budget-isolation` | `062cd18f3aa0a8fd9cc7dab5ece2f9359bed4374` | Draft · mergeable `clean` |
| PR #157 `test-integrity/zero-skip-guard` | `d7e148182156eab9f4efffa0df9bce925c179d67` | Draft · mergeable `clean` |
| PR #158 `p7/b3-metadata-minimization` | `53eb6b4fa15bc7dc3dcac8a20f124f48674d5e60` | Draft · mergeable `clean` |
| PR #159 `security/independent-audit-20261009` | `8e10f51b7c60bab533edad4373414002caae4a7a` | Draft · mergeable `clean` · **opened by a different agent** |
| Issue #133 | open | "P7 gate: Full Bridge test failure, skip and CI execution audit" |

All five PRs branch from `c517364` (0 commits behind `main`).

### Local-only state (NOT on GitHub)

| Item | Where | Transfer |
|---|---|---|
| Integration branch `integration/five-pr-20261009`, HEAD `7a70572`, tree `594c0d713e4cfc2f5bf25de8208eb1396bbbed15` | Claude's container only, never pushed | Rebuild deterministically (§6); compare tree hash |
| **Unverified** fixes to 6 false-green tests (`e2e/tests/security.spec.ts`, `e2e/tests/profile.spec.ts`) | uncommitted in Claude's #156 worktree | `unverified-vacuous-status-fixes.patch` in this folder (applies cleanly to `062cd18`, checked with `git apply --check`) |
| Logs / result JSON | Claude's container | Not transferable; the numbers are copied into §3 |

Other worktrees that existed locally (`wt-b2`, `wt-nv`, `wt-pl`, `wt-hp`, `p5/*`) only hold commits that are already in `main`. Nothing to transfer.
`/home/user/Bridge` (the main checkout) belongs to another agent: branch `p7/local-first-openai` with an uncommitted
`scripts/abuse-lab/run.mjs` change. **Do not touch it.**

### Background processes at handoff time

An integration E2E matrix (`scripts/int-e2e-matrix.sh` in this folder) ran on the integration tree while the handoff
was prepared and **finished** (results in §3.4). No test processes were left running. The logs are local only. Codex must
re-run anything it relies on, at minimum Firefox and WebKit, which could not launch here.

---

## 2. What the five PRs contain

| PR | Content | Own CI on head |
|---|---|---|
| #155 | Firefox COOP warm-up in the shared `e2e/helpers/apiTest.ts` page fixture (Juggler loses the main world after the COOP process swap → 30 s timeouts). Avatar-fallback trace; plugin wildcard/unregister isolation test. | All green, **including the full matrix** (`E2E full + media` job ran because the head ref is allow-listed): Chromium, WebP-enabled, RustFS S3 remote, Firefox, WebKit, Media, Mobile, a11y×3 — Quality Gate run `37939667453`. |
| #156 | E2E tests that passed on 429/404 now assert the real contract; product fix: voice REST router mounted at `/channels` (was `/servers`, documented URLs 404'd) with `server/tests/voice-route-mount-contract.test.ts`; own-address loopback client for the 2FA budget; 20 lenient status assertions pinned to exact values; 7 conditional-only tests made unconditional; E2E server pins VAPID off; ledger `docs/test-integrity/2026-10-09-repo-wide-audit.md`. | All workflows green. **`E2E full + media` job SKIPPED** (not allow-listed): Firefox/WebKit/media/mobile/a11y not run by CI for this head. Local full chromium on `062cd18`: 527 passed / 0 failed / 0 skipped (`--retries=0`). |
| #157 | `scripts/require-no-skipped-tests.js` (+6 tests): server Jest, mobile Jest and real-PG/Redis/S3 steps fail if any test is pending/todo/skipped or none ran. | All green. Guard output in CI: mobile `127/127 … 0 skipped`, real PG/Redis/S3 `156/156 … 0 skipped`, server step passed. Self-host (processes) needed one re-run (lab Redis start timeout, not touched by the PR; explained in a PR comment). `E2E full` skipped. |
| #158 | B3-1: `server/lib/imageMetadata.ts` lossless metadata strip on every raster upload route (JPEG/PNG/WebP/GIF), fail-closed 422 `IMAGE_UNPARSEABLE`; WebP conversion now applies EXIF orientation (`.rotate()`); self-host lab fixture replaced (old one was a corrupt PNG). | All green on `53eb6b4` (incl. Self-host, Step-up Lab, Federation, Android). `E2E full` skipped. |
| #159 | (other agent) semantic-search history/cache confidentiality (`VIEW_CHANNELS`+`READ_HISTORY`), hidden presence on public surfaces, exact HTTP-signature 202 assertion, security corpus registration, audit docs incl. `docs/security-audits/2026-10-09-test-integrity-candidates.json` (2,159 textual candidates, all `CANDIDATE_NOT_PROVEN`). | All green. `E2E full` skipped. Its own description states browser E2E for it was not verified. |

Only file touched by two PRs: `e2e/helpers/apiTest.ts` (#155 page fixture + #156 generic `withCsrf<T>`); auto-merged, reviewed, coherent.

---

## 3. Evidence on the combined tree (local, tree `594c0d7…`)

Environment: Claude Code cloud container, root, 4 CPU, Node 24, PostgreSQL **16** (CI uses 18-alpine), redis-server,
`moto_server` as the S3-compatible endpoint (CI uses RustFS; **neither is Cloudflare R2**), Playwright browsers
chromium-1228 / firefox-1532 / webkit-2311.

### 3.1 Completed and passed

| Family | Command (run from the integration checkout) | Result |
|---|---|---|
| Server typecheck | `npx tsc -p server/tsconfig.json --noEmit` | exit 0 |
| Client typecheck | `npx tsc -p client/tsconfig.json --noEmit` | exit 0 |
| E2E typecheck | `cd e2e && npx tsc -p tsconfig.json --noEmit` | exit 0 |
| Test ownership | `node scripts/verify-test-ownership.js` | every test file owned |
| Release integrity | `npm run test:release-integrity` | 188 / 188, 0 skipped |
| Server Jest (CI command) | `cd server && npx jest --coverage --runInBand --forceExit --json --outputFile=jest-results.json` then `node scripts/require-no-skipped-tests.js server/jest-results.json --label "server Jest"` | **627 suites, 12,046 passed, 0 failed, 0 pending, 0 todo**; guard ✅ |
| Server lint | `cd server && npm run lint` | exit 0 |
| Hardening typecheck | `cd server && npm run typecheck:hardening` | exit 0 (0 declared debt) |
| Prod-deps contract | `cd server && npm run check:prod-deps` | PASS |
| Client + server build | `npm run build && (cd server && npm run build)` | exit 0 |
| Mobile bridge + packaged shell | `npx jest --config jest.mobile.config.js --runInBand --forceExit --json --outputFile=…` + guard | **127 / 127, 0 skipped** |
| Real PG + Redis + S3(moto) | `scripts/int-pgtest.sh` (schema+migrations, then `cd server && npx jest --config jest.pg.config.js --runInBand --forceExit --json …` + guard) | **26 suites, 159 / 159, 0 skipped** (156 on main + 3 from #159) |
| Live unified-search planner | `SEARCH_IT_DATABASE_URL=… npm run test:search-it` | 16 / 16 |
| pgvector (real extension, PG16) | `PGVECTOR_TEST_URL=… PG_TEST_URL=… npx jest --config jest.pg.config.js … pgvector-embedding.pgtest.ts` | 12 / 12 |
| Production SQL vs PostgreSQL | `PG_TEST_URL=… node scripts/verify-sql-against-postgres.js` | all static SQL accepted |
| Migration rollback gate | `PG_TEST_URL=… node scripts/verify-migration-rollback.js --ordered` | ✅ every migration lossless or justified |

Note: a first PG attempt failed in ~60 tests because the script had skipped the schema/migration step that CI's earlier
steps perform. That was a harness mistake, fixed by adding the step, not a product defect.

### 3.2 Not run on the combined tree (UNVERIFIED)

(For the Playwright matrix see §3.4. Firefox and WebKit are unverified there.)

Client Vitest + coverage gate (`npm run test:svelte:coverage`), Electron tests, bot-sdk, plugins, discord-shim:
**not run**. The combined diff touches none of `client/ mobile/ electron/ bot-sdk/ plugins/ discord-shim/`
(verified with `git diff --stat origin/main HEAD -- …`), so their inputs equal `main`'s. `main`'s push CI on `c517364`
was green for them. Still, they were not executed on this tree.
Also not run on the combined tree: Abuse Lab, Step-up Lab, Federation lab, Self-host labs, Android emulator, iOS simulator
(each ran green on the individual PR heads where their path filters matched; see §2).

### 3.3 Weekly labs: never run on current main or on the PRs

| Lab | Last run | Relevance |
|---|---|---|
| `multinode-evidence.yml` (schedule Mon / dispatch only) | `bc658e7` 2026-10-05 success | #159 changes presence (`server/lib/userUtils.ts`, `routes/activity.ts`); #156 changes the voice REST mount. **UNVERIFIED** on `c517364` and on the PRs. |
| `media-evidence.yml` (schedule Tue / dispatch only) | `bc658e7` 2026-10-06 success | **UNVERIFIED** on `c517364` and on the PRs. |
| `abuse-lab.yml`, `stepup-lab.yml` schedules | added 2026-10-07 / 10-08; first scheduled run is Tue 2026-10-13 | Not a defect. The combined diff matches 0 abuse-lab path filters and 1 step-up path filter (`server/routes/auth.ts`, changed by #158 for the avatar metadata strip). Step-up lab ran green on #158 heads `39e9504` and `53eb6b4`. Abuse Lab did not run on any of the five PRs. |

### 3.4 Integration E2E matrix — completed 2026-10-10 00:06 UTC (combined tree `594c0d7…`)

Script: `scripts/int-e2e-matrix.sh` (CI `e2e-full` order, one shared PostgreSQL 16 DB, `--retries=0`).

| Project / step | Result | Status |
|---|---|---|
| chromium (full) | **532 passed / 0 failed / 0 skipped** (13.9 min) | PASS (= 527 on main-based #156 + 5 B3 image-metadata tests) |
| webp-enabled (`WEBP_CONVERT=true`, `webp-upload.spec.ts`) | 8 / 8 | PASS |
| s3-remote (`remote-storage.spec.ts`) against **moto** | 1 / 1 | PASS on moto only. **Not** RustFS (CI) and **not** R2 |
| firefox | 2 passed, 25 "failed" in 2–3 ms each: `browserType.launch: Executable doesn't exist at …/firefox-1532/firefox/firefox` | **NOT RUN (environment: browser binary missing in Claude's container)**. No product signal |
| webkit | same, `…/webkit-2311/pw_run.sh` missing | **NOT RUN (environment)** |
| voice-media | 33 / 33 | PASS |
| mobile | 6 / 6 | PASS |
| a11y / a11y-mobile / a11y-keyboard | 10 / 10 · 10 / 10 · 8 / 8 | PASS |
| api-smoke (`smoke-health.spec.ts`) | 3 / 3 | PASS |
| visual (no workflow runs it) | 14 / 14 | PASS locally; 9 asserting tests + capture tools |
| perf (no workflow runs it) | 1 / 1 | PASS locally (asserts samples only) |

Firefox and WebKit on the **combined** tree therefore remain **UNVERIFIED**. #155's CI ran them green on `c1a72a9`
(main + #155 only); the other four PRs never ran them in CI.

---

## 4. Findings

### 4.1 Confirmed facts that matter for merging

1. **`main`'s nightly Quality Gate is red.** Schedule run `37902630376` on `c517364` (2026-10-09): only failure is
   `E2E full + media → Firefox compatibility suite`, `tests/cross-browser-core.spec.ts:86` ("API çağrısı ÇALIŞIR"),
   `Test timeout of 30000ms exceeded`. Earlier nightlies: `ffc2a9d` failed Chromium+Firefox+WebKit; `bc658e7` ×3 failed
   the security audit step. #155 is the fix: its own CI ran the whole full matrix green, and `cross-browser-core.spec.ts`
   imports the patched `../helpers/apiTest` fixture.
2. **CI never ran Firefox/WebKit/media/mobile/a11y for #156–#159** (`E2E full + media` skipped, only allow-listed head
   refs run it on PRs). The combined tree's full matrix is therefore only proven by the next nightly after merge, or by
   a local run (§3.4 / task list).
3. `visual` (14 tests, 3 files) and `perf` (1 test) Playwright projects are **run by no workflow**.
4. Static skip inventory on the combined tree (37 sites in 1,094 test files): all env/platform-gated
   (`PG_TEST_URL`/`REDIS_TEST_URL`/`MINIO_TEST_ENDPOINT` suites, guarded by #157 in CI; mobile bundle suites, guarded;
   Electron Windows-only `it.skip` on non-win32, runs on the Windows job; WebAuthn non-Chromium), or historical comments.
   #159's new `semantic-confidentiality.pgtest.ts` throws (fails closed) without PG/Redis: compatible with #157's guard.
5. No `passWithNoTests`; no `continue-on-error` on test steps; every Playwright CI invocation has `--retries=0`
   (config default is `retries: process.env.CI ? 2 : 0`, but all CI commands override it).
6. Low-risk fragility (not a CI defect): `e2e/tests/typing-convergence.spec.ts:41` and `e2e/tests/realtime-torture.spec.ts:91`
   call `getTokens()` at module load. Without `e2e/fixtures/tokens.json`, `playwright test --list` throws and reports
   `Total: 0`, also for the whole chromium project. In CI the PR "changed specs" step lists only after the security E2E step
   has created the fixtures, so it is not exploited today. Ad-hoc audits that use `--list` must create fixtures first.

### 4.2 False-green tests: confirmed by reading the assertion (the assertion cannot fail on the claimed defect)

All in `e2e/tests/` on the combined tree, not fixed in any PR yet (fix exists only as the **unverified** patch):

| # | Test | Why it is false-green |
|---|---|---|
| D1 | `security.spec.ts:143` "temiz SVG yüklenebilmeli (200)" | only `expect(status).not.toBe(500)`; a 400/415/422/429 refusal of a clean SVG passes |
| D2 | `security.spec.ts:367` "geçerli PNG yüklenebilmeli" | fixture is **not a valid PNG** (IHDR CRC `90012e00` is wrong; hex string malformed); only `not 500`, `not 401` |
| D3 | `profile.spec.ts:175` "POST /api/me/avatar — küçük PNG yüklenebilmeli" | same corrupt PNG fixture; only `not 401`, `not 500` |
| D4 | `security.spec.ts:292` "refresh token bir kez kullanılabilmeli (rotation)" | asserts only that the first refresh is not 500; rotation and reuse are never tested |
| D5 | `security.spec.ts:471` "geçerli CSRF token ile mutating istek başarılı olmalı" | `not 403`, `not 500`: 400/409/429 pass, so success is never proven |
| D6 | `security.spec.ts:496` "aynı CSRF token ikinci istekte hâlâ geçerli olmalı" | only `not 403` twice |
| D7 | `security.spec.ts:189` "mevcut bir SVG dosyası için güvenlik header kontrolü" | HEADs a **non-existent** file, accepts 401/403, and the only header check is under `if (status === 200)`. The served-SVG security headers (`X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'none'; sandbox`, set in `server/middleware/uploadAuthz.ts` and `server/app/createApp.ts`) are never verified. **Not in the patch.** |
| D8 | `profile.spec.ts:47` "PATCH /api/me — displayName güncellenebilmeli" | persistence check is inside `if (meRes.ok())`. **Not in the patch.** |
| D9 | `link-preview.spec.ts:31` and `:146` | `not 500`/`not 401` only; positive path needs outbound internet and the SSRF guard refuses a local fixture by design. Already documented as class B in the #156 ledger. |

**Suspected, not measured:** with #158 (B3) merged, the corrupt PNG fixtures in D2/D3 are likely refused with 422
`IMAGE_UNPARSEABLE`, and these tests would still pass. The actual status on `main` and on the combined tree was **not measured**.

### 4.3 Measured server contracts (from code; confirm by test run)

- `POST /api/upload` success → `200 { url: "/uploads/<id>" }` (any provider). Dangerous SVG → content scanner `422 {error:'SVG contains dangerous content', code:'SVG_XSS'}` (quarantined).
- `POST /api/me/avatar` success → `200 { avatarUrl }` (`server/routes/auth.ts:724`).
- `POST /api/servers` success → `200` server object.
- `POST /api/refresh` (`server/routes/auth.ts:354`): token from cookie `bridge_refresh` or body `refreshToken`; success `200 {token}` + new `bridge_refresh` cookie; reuse of a used token → `401 {reason:'reuse'}` and the **family's** refresh rows are deleted (`server/db/repositories/AuthRepository.ts` ~L128). `tokenVersion` is not bumped, so access tokens and other families are unaffected.

---

## 5. Remaining broad status assertions (not individually adjudicated)

AST sweep (`tools/neg-status-sweep.js`) lists tests whose only status assertions are negative or ranges. 33 of them are
`toBeLessThan(300)`, which means "any 2xx". That rejects 4xx/5xx, so they are coarse but **not** vacuous; tightening to the exact code is optional
polish. `settings.spec.ts:58` uses `toBeLessThan(400)` (accepts 3xx). Redundant `toBeLessThan(500)` after an exact `toBe(401|400)`:
`auth.spec.ts:43`, `security.spec.ts:334`, harmless. `web-push.spec.ts:131` (`not 500` + `<300`) and
`webhook-security.spec.ts:137` (regression guard against a 500 crash) were judged acceptable.

---

## 6. How to rebuild the integration tree

```bash
git fetch origin main test-integrity/integrated-audit test-integrity/zero-skip-guard \
  test-integrity/2fa-budget-isolation p7/b3-metadata-minimization security/independent-audit-20261009
git switch -c integration/five-pr-<date> c517364b9289d13e16101a30d080ca51125971a5
for b in test-integrity/integrated-audit test-integrity/zero-skip-guard test-integrity/2fa-budget-isolation \
         p7/b3-metadata-minimization security/independent-audit-20261009; do git merge --no-ff --no-edit origin/$b; done
git rev-parse HEAD^{tree}   # expect 594c0d713e4cfc2f5bf25de8208eb1396bbbed15 if no PR head moved
```
No conflicts occurred in that order. If any PR head moved, the tree hash will differ (expected).

---

## 7. Next actions (priority order)

1. Verify and land the D1–D6 patch (and fix D7, D8) on a new branch, with negative controls. Measure on `main`-based and combined trees.
2. Run Firefox and WebKit on the combined tree (they could not launch in Claude's container); re-confirm the rest of the matrix.
3. Run `multinode` (per-node all scenarios + shared `uploads`) and the media lab on the combined tree.
4. Decide on CI coverage for `visual`/`perf` and for the full matrix on non-allow-listed PRs (proposal, owner approval).
5. Trace the root-relative stylesheet 404s (`/tokens.css`, `/modules/*.css`; order-dependent, seen in a11y.flows + one cross-browser test).
6. R2: identify what only real Cloudflare R2 can prove; RustFS/moto are S3-API evidence only.
7. Re-evaluate #133 against its completion criteria; produce the merge-readiness report and the sequence.

Suggested merge sequence (for the owner; **not** executed): #155 → #157 → #156 → #158 → #159, each after a re-check of
CI on the then-current head. Rationale: #155 makes `main`'s nightly green, #157 adds guards before more tests land, #156
is test-only plus a small route-mount fix, #158 changes upload behaviour (needs D2/D3 fixed first or at the same time),
#159 is security behaviour from a different agent and has the least browser evidence.

---
## 8. Transfer instructions (Claude Code and Codex run on different machines)

What Codex needs is on GitHub. Nothing else is required from Claude's container.

| Need | Where | How |
|---|---|---|
| This checkpoint, the prompt, the patch, tools, runner scripts | branch `handoff/codex-2026-10-09`, folder `docs/handoff/2026-10-09-codex/` | `git fetch origin handoff/codex-2026-10-09 && git checkout origin/handoff/codex-2026-10-09 -- docs/handoff/2026-10-09-codex` (into a scratch branch), or `git show origin/handoff/codex-2026-10-09:<path>` |
| The five PR heads | PR branches on GitHub (§1) | `git fetch origin <branch>` |
| Integration tree | not pushed (local only) | rebuild with §6 and compare the tree hash `594c0d713e4cfc2f5bf25de8208eb1396bbbed15` |
| Unverified D1–D6 fix | `unverified-vacuous-status-fixes.patch` (SHA-256 prefix `93321aa467e15708`) | `git switch -c test-integrity/vacuous-status-<date> origin/test-integrity/2fa-budget-isolation && git apply <patch>`. It applies cleanly to `062cd18`. Keep `security.spec.ts` CRLF. |
| Logs / JSON results | local only, **not transferable** | numbers are reproduced in §3; re-run to re-establish |
| CI evidence | GitHub Actions | run IDs in §2, §4.1 (`37939667453` #155 full matrix, `37902630376` main nightly failure) |

The handoff branch is docs-only on top of `main` (`c517364`). Pushing it triggers no workflow (push triggers are limited to
`main`/`develop` and `v*` tags). **Never merge it and never open a PR for it.** Delete it only with the owner's approval once the
handoff is consumed.
