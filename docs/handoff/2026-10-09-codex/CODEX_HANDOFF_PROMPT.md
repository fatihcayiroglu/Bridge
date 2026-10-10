# Codex task — Bridge: finish the five-PR integration, test-integrity and security verification

You are taking over verification work on the GitHub repository **`fatihcayiroglu/Bridge`** from a previous agent
(Claude Code). That agent ran on a different machine. **You cannot see its filesystem.** Everything it left for you is
on GitHub, in the branch **`handoff/codex-2026-10-09`**, folder **`docs/handoff/2026-10-09-codex/`**:

| File | What it is |
|---|---|
| `HANDOFF_CHECKPOINT.md` | Factual state: SHAs, CI conclusions, measured results, findings. **Read it first.** |
| `CODEX_HANDOFF_PROMPT.md` | This prompt. |
| `unverified-vacuous-status-fixes.patch` | Uncommitted, **unverified** fix for 6 false-green E2E tests. It applies cleanly to PR #156's head `062cd18`. It was typechecked, **never executed**. |
| `tools/cond-sweep.js`, `tools/neg-status-sweep.js` | AST sweeps (TypeScript compiler API) for tests whose assertions are all conditional, or whose status assertions are all negative. Usage: `cd e2e/tests && node <tool> ../node_modules/typescript *.ts` |
| `scripts/int-pgtest.sh`, `scripts/int-e2e-matrix.sh`, `scripts/int-labs.sh`, `scripts/ti-e2e.sh` | The previous agent's local runners, with machine paths turned into parameters (`S` scratch dir, `W` checkout, `PGBIN`, `MOTO_SERVER`). They need root (they use `su postgres`; the media lab needs network namespaces). Read them as recipes; adapt them to your environment. |

Fetch them with:
```bash
git fetch origin handoff/codex-2026-10-09
git show origin/handoff/codex-2026-10-09:docs/handoff/2026-10-09-codex/HANDOFF_CHECKPOINT.md
git show origin/handoff/codex-2026-10-09:docs/handoff/2026-10-09-codex/unverified-vacuous-status-fixes.patch > /tmp/vacuous.patch
```
That branch contains only these docs on top of `main`. **Never merge it and never open a PR for it.**

---

## 0. Non-negotiable safety rules

1. **No merging** of any PR and **no change to `main`** (no push, no merge, no branch protection change) without the owner's explicit approval in this task.
2. **Do not close issue #133** and **do not mark P7 complete**. You may draft a closure assessment; only the owner closes.
3. **Never modify, stage, commit, stash, reset, rename or delete `scripts/abuse-lab/run.mjs`.** (Another agent has a paused local edit of it. Running the committed version of the Abuse Lab is allowed; changing the file is not.)
4. **No force-push, no rebase/amend of pushed commits, no history rewriting** on any branch.
5. **No weakening**: do not loosen assertions, remove checks, lower coverage thresholds, relax rate limits or security controls, broaden accepted status codes, or mock away the real service a test claims to exercise.
6. **No artificial green**: no new `test.skip` / `test.fixme` / `.only` / `describe.skip` / `it.skip` / `todo`, no `--retries` above 0 in evidence, no `continue-on-error`, no `|| true` on test steps, no swallowed errors, no deleted tests.
7. **No invented results.** Report only what you ran and saw. A test that did not run, could not run, or ran in a different environment is **NOT RUN / UNVERIFIED** with the reason, never "passed".
8. **S3 is not R2.** RustFS (CI) and moto (local) are S3-API evidence only. Never report them as Cloudflare R2 or MinIO-vendor proof.
9. **Do not touch other agents' work**: never push to PR #159's branch (`security/independent-audit-20261009`, another agent's); never modify a branch you did not create unless the owner tells you to. To fix something in another agent's PR, propose a patch in your report instead.
10. **No destructive cleanup** (no `git clean -fdx` on shared trees, no deleting branches/worktrees/artifacts you did not create).
11. **New work goes on new, clearly named branches** (e.g. `test-integrity/<topic>-<date>`). You may also push to the PR branches the previous agent created and owns (#156 `test-integrity/2fa-budget-isolation`, #157 `test-integrity/zero-skip-guard`, #158 `p7/b3-metadata-minimization`, #155 `test-integrity/integrated-audit`), but only fast-forward commits, only after verification, and only with the owner's go-ahead if the change goes beyond the PR's stated scope.
12. **Push and open Draft PRs only for verified changes.** Before every push, check that no workflow in the repo is `queued` or `in_progress`; if one is, wait. Never mark a PR ready for review and never enable auto-merge.
13. Commit messages and PR bodies must not contain model identifiers. Keep each commit small and logical.

---

## 1. Context

**Repository state at handoff (2026-10-09 ~23:50 UTC):**

- `main` = `c517364b9289d13e16101a30d080ca51125971a5`.
- Five open **Draft** PRs, all branched from `c517364`, all with green CI on their heads, all `mergeable_state: clean`:

| PR | Branch | Head | Summary |
|---|---|---|---|
| #155 | `test-integrity/integrated-audit` | `c1a72a9a88e85cf4408fa7d8cd82453949cba710` | Firefox COOP process-swap warm-up in `e2e/helpers/apiTest.ts` page fixture (fixes 30 s Firefox timeouts); plugin isolation test. **Fixes main's red nightly.** |
| #156 | `test-integrity/2fa-budget-isolation` | `062cd18f3aa0a8fd9cc7dab5ece2f9359bed4374` | E2E tests that passed on 429/404 now assert real contracts; voice REST router mount fix (`/channels`); 20 lenient status assertions pinned; 7 conditional-only tests fixed; E2E server pins VAPID off; ledger `docs/test-integrity/2026-10-09-repo-wide-audit.md`. |
| #157 | `test-integrity/zero-skip-guard` | `d7e148182156eab9f4efffa0df9bce925c179d67` | `scripts/require-no-skipped-tests.js`: server, mobile and real-PG/Redis/S3 CI steps fail on any skipped/todo test or zero tests. |
| #158 | `p7/b3-metadata-minimization` | `53eb6b4fa15bc7dc3dcac8a20f124f48674d5e60` | P7 B3-1: lossless image metadata strip on all raster upload routes (422 `IMAGE_UNPARSEABLE` fail-closed), WebP orientation fix, self-host lab fixture fix. |
| #159 | `security/independent-audit-20261009` | `8e10f51b7c60bab533edad4373414002caae4a7a` | **Another agent's** PR: semantic-search history/cache confidentiality, hidden presence, HTTP-signature assertion, audit docs (`docs/security-audits/2026-10-09-*`). |

If any head has moved since, re-read the PR and use the new head. Note the change in your report.

- **Issue #133** ("P7 gate: Full Bridge test failure, skip and CI execution audit") is open. Its completion criteria (read the issue body in full on GitHub):
  - 0 reproducible failures in all run-capable suites;
  - 0 unexplained/unexpected skips;
  - 0 unowned or silently unexecuted test files;
  - every deliberate skip has an audited reason, owner, environment requirement and an execution plan or evidence;
  - no job goes falsely green; CI and nightly/weekly evidence are enumerated by exact commit;
  - non-executable tests stay **unverified**, not "passed";
  - a final full-repository summary table with links.

**Key facts already established** (details and evidence in `HANDOFF_CHECKPOINT.md`):

- `main`'s **nightly Quality Gate is red**: run `37902630376` on `c517364` fails only `E2E full + media → Firefox compatibility suite` (`tests/cross-browser-core.spec.ts:86`, 30 s timeout). #155's CI ran the full matrix green.
- For **#156–#159, CI skipped the `E2E full + media` job** (only allow-listed head refs run it on PRs). Firefox, WebKit, voice-media, mobile, a11y×3 and the RustFS remote-storage E2E were **not** run by CI for them.
- The **combined tree** of all five PRs (merge order #155, #157, #156, #158, #159 on `c517364`; no conflicts; tree hash `594c0d713e4cfc2f5bf25de8208eb1396bbbed15`) was verified locally:
  - typecheck server/client/e2e;
  - server lint, hardening typecheck, prod-deps;
  - test ownership; release integrity 188/188;
  - server Jest **627 suites / 12,046 passed / 0 failed / 0 skipped**;
  - mobile 127/127;
  - real PG16+Redis+moto-S3 suite **26 suites / 159 passed / 0 skipped**;
  - search-it 16/16; pgvector 12/12; SQL validation; migration rollback gate.
- Local Playwright matrix on the combined tree (PostgreSQL 16, one shared DB, `--retries=0`), all passed:
  - chromium **532/532**; WebP-enabled 8/8; s3-remote **on moto** 1/1;
  - voice-media 33/33; mobile 6/6; a11y 10/10; a11y-mobile 10/10; a11y-keyboard 8/8;
  - api-smoke 3/3; visual 14/14; perf 1/1.
- **Firefox and WebKit could NOT run** there (browser executables missing: `browserType.launch: Executable doesn't exist`), so they are **UNVERIFIED** on the combined tree.
- **Not run** on the combined tree:
  - client Vitest + coverage, Electron, bot-sdk, plugins, discord-shim (their code is byte-identical to `main`);
  - Abuse, Step-up, Federation and Self-host labs;
  - Android and iOS;
  - RustFS S3 E2E;
  - multinode and media labs.
- The weekly **multinode** and **media** labs last ran on `bc658e7` (2026-10-05/06). They never ran on `c517364` or on any of the five PRs. #159 changes presence code and #156 the voice REST mount, both exercised by multinode.
- `visual` (14 tests) and `perf` (1 test) Playwright projects are run by **no** workflow.

---

## 2. Your tasks, in priority order

Work through these in order. After each, record the result in a running report (see §4).

### T1. Fix the confirmed false-green E2E tests (highest priority)

Confirmed by reading (each assertion cannot fail on the defect it claims to catch). File paths are relative to the repo root on the combined tree:

| ID | Test | Defect | Real contract (from server code — confirm by running) |
|---|---|---|---|
| D1 | `e2e/tests/security.spec.ts` "temiz SVG yüklenebilmeli (200)" | only `not.toBe(500)` | `POST /api/upload` with a clean SVG → `200`, body `url` matches `^/uploads/[A-Za-z0-9._-]+$` |
| D2 | `e2e/tests/security.spec.ts` "geçerli PNG yüklenebilmeli" | fixture is a **corrupt** PNG (IHDR CRC `90012e00` wrong); only `not 500`/`not 401` | valid PNG → `200` + `url` as above |
| D3 | `e2e/tests/profile.spec.ts` "POST /api/me/avatar — küçük PNG yüklenebilmeli" | same corrupt fixture; only `not 401`/`not 500` | valid PNG → `200 { avatarUrl }` with `avatarUrl` starting `/uploads/` (`server/routes/auth.ts` ~L724) |
| D4 | `e2e/tests/security.spec.ts` "refresh token bir kez kullanılabilmeli (rotation)" | only "first refresh not 500"; reuse never tested | `POST /api/refresh` (`server/routes/auth.ts` ~L354): first use `200 {token}` + a **different** `bridge_refresh` cookie; reusing the original token (body `refreshToken`, cookie-less client) → `401 {reason:'reuse'}`; then the rotated token → `401` (family deleted in `server/db/repositories/AuthRepository.ts` ~L128; `tokenVersion` is not bumped, so other sessions are unaffected) |
| D5 | `e2e/tests/security.spec.ts` "geçerli CSRF token ile mutating istek başarılı olmalı" | `not 403`/`not 500` | `POST /api/servers` with valid CSRF → `200`, body `name` = `CSRFValidServer` |
| D6 | `e2e/tests/security.spec.ts` "aynı CSRF token ikinci istekte hâlâ geçerli olmalı (stateless mod)" | only `not 403` ×2 | both requests `200` |
| D7 | `e2e/tests/security.spec.ts` "mevcut bir SVG dosyası için güvenlik header kontrolü" | HEADs a nonexistent file; header check only under `if (status === 200)` | upload a clean SVG as a user, GET it **as that user**, expect `200`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'none'; sandbox`, `Content-Type: image/svg+xml` (set in `server/middleware/uploadAuthz.ts` / `server/app/createApp.ts`); keep the anonymous-request refusal as a separate assertion |
| D8 | `e2e/tests/profile.spec.ts` "PATCH /api/me — displayName güncellenebilmeli" | persistence check inside `if (meRes.ok())` | `GET /api/me` → exactly `200` and `displayName` equals the new value |

`unverified-vacuous-status-fixes.patch` implements **D1–D6** (not D7, D8). It was **never run**. Treat it as a draft.

Procedure:
1. **Reproduce the false green.** On `main` and on the combined tree, run the original tests:
   ```bash
   cd e2e && npx playwright test tests/security.spec.ts tests/profile.spec.ts --project=chromium --retries=0 --reporter=list
   ```
   They pass. Then record what they **actually** receive: add a temporary `console.log(res.status(), await res.text())`, or write a temporary probe spec, and **delete it afterwards**. This is especially important for the corrupt PNG on `main` vs on the #158 (B3) tree. The suspicion is that B3 turns it into `422 IMAGE_UNPARSEABLE` while the old test still passes. That is not yet measured.
2. **Negative controls** (the new assertions must fail when the contract breaks). For each, demonstrate one, then revert it:
   - D1/D2/D3: send the old corrupt PNG, or an SVG with `<script>`, to the new test body. It must fail (422 ≠ 200).
   - D4: comment out the reuse branch's family deletion locally, or replay the rotated token instead of the original. The test must fail.
   - D5/D6: send a wrong CSRF token. It must fail (403 ≠ 200).
   - D7: locally remove the SVG CSP header. It must fail.
   - D8: PATCH a different value than the one asserted. It must fail.
   Never commit a negative-control change.
3. **Fix** by applying the patch (`git apply /tmp/vacuous.patch` on a branch from `062cd18`, or recreate it), then add D7 and D8. Use a **valid** PNG fixture (the repo already uses `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==` in `e2e/tests/upload.spec.ts`). Production validation must not change. Keep `security.spec.ts`'s CRLF line endings.
4. **Verify** with `--retries=0` on (a) the #156 branch (`main`-based) and (b) the combined integration tree:
   ```bash
   cd e2e && npx playwright test tests/security.spec.ts tests/profile.spec.ts tests/upload.spec.ts tests/webp-upload.spec.ts tests/image-metadata.spec.ts --project=chromium --retries=0 --reporter=list
   ```
   (`image-metadata.spec.ts` exists only with #158.) Also `cd e2e && npx tsc -p tsconfig.json --noEmit`.
5. Where to land it: commit to `test-integrity/2fa-budget-isolation` (PR #156, the E2E test-integrity PR) as fast-forward commits, or to a new branch `test-integrity/vacuous-status-<date>` with its own Draft PR. Then update the PR body and the ledger `docs/test-integrity/2026-10-09-repo-wide-audit.md`, which currently claims these classes are closed. Correct that claim.
6. Then sweep for more: `tools/neg-status-sweep.js` and `tools/cond-sweep.js` over `e2e/tests`. `toBeLessThan(300)` means "any 2xx", which is coarse but not vacuous. Adjudicate each remaining hit individually. #159's `docs/security-audits/2026-10-09-test-integrity-candidates.json` (2,159 textual candidates at base `c517364`) is a second input; on the combined tree 12 `broad_status`, 24 `conditional_status`, 51 `early_return`, 4 `empty_catch` E2E sites still exist. Only list a defect as confirmed with evidence.

### T2. Full Playwright matrix on the combined tree (Firefox and WebKit first — they are the unverified ones)

Build the integration branch (recipe in `HANDOFF_CHECKPOINT.md` §6), then:
```bash
npm ci && (cd server && npm ci) && (cd e2e && npm ci) && npx playwright install --with-deps chromium firefox webkit
npm run build && (cd server && npm run build)
# PostgreSQL with role bridge/test_password and DB bridge_test, then:
cd server && npx ts-node --project tsconfig.json db/postgres/index.ts && npx ts-node --project tsconfig.json db/migrate-postgres.ts up && cd ..
export DATABASE_URL=postgresql://bridge:test_password@127.0.0.1:5432/bridge_test JWT_SECRET=ci_jwt_secret_minimum_32_chars_value REFRESH_SECRET=ci_refresh_secret_minimum_32_chars BASE_URL=http://127.0.0.1:3000
cd e2e
npx playwright test --project=chromium --retries=0 --reporter=list
WEBP_CONVERT=true npx playwright test tests/webp-upload.spec.ts --project=chromium --retries=0 --reporter=list
npx playwright test --project=firefox --retries=0 --reporter=list
npx playwright test --project=webkit  --retries=0 --reporter=list
npx playwright test --project=voice-media --retries=0 --reporter=list
npx playwright test --project=mobile --retries=0 --reporter=list
for p in a11y a11y-mobile a11y-keyboard; do npx playwright test --project=$p --retries=0 --reporter=list; done
npx playwright test tests/smoke-health.spec.ts --project=api-smoke --retries=0 --reporter=list
# S3 remote (RustFS like CI, else moto — label which):
#   env WEBP_CONVERT=false CDN_PROVIDER=minio PRIVATE_STORAGE_PROVIDER=minio MINIO_ENDPOINT=… MINIO_ACCESS_KEY=… MINIO_SECRET_KEY=… MINIO_BUCKET=bridge-public PRIVATE_MINIO_BUCKET=bridge-private MINIO_PUBLIC_URL=<endpoint>/bridge-public
#   after `node scripts/ci-provision-minio.mjs` (see .github/workflows/quality-gate.yml, e2e-full job)
#   npx playwright test tests/remote-storage.spec.ts --project=s3-remote --retries=0 --reporter=list
# Not in CI — run and report separately:
npx playwright test --project=visual --retries=0 --reporter=list
npx playwright test --project=perf --retries=0 --reporter=list
```
CI runs all of these sequentially on **one** database. Do the same (or state the difference). Report passed/failed/skipped/flaky per project. Investigate every failure to a root cause; a timeout is not a root cause. Firefox depends on #155's fixture.

Copy the exact S3 env from the CI step `Real S3 protected upload E2E (zero retries)`.

### T3. Multinode lab, both upload configurations (combined tree)
```bash
# needs redis-server, lsof, moto_server (pip install 'moto[server]==5.2.3'), PostgreSQL binaries; server built
MN_MOTO_SERVER=$(command -v moto_server) node scripts/multinode/run.mjs --scenarios 'auth,realtime,stale,nodedeath,redis,postgres,jobs,sfu,uploads' --uploads per-node --work <dir> --out <dir>
MN_MOTO_SERVER=$(command -v moto_server) node scripts/multinode/run.mjs --scenarios 'uploads' --uploads shared --work <dir> --out <dir>
```
Exit code 0 means no FAIL. BLOCKED/SKIPPED never count as PASS. Report the `summary:` line and every non-PASS check.

### T4. Media lab (combined tree)
Root, `/dev/net/tun`, iproute2, nftables, coturn, faketime, Chromium, moto (see `.github/workflows/media-evidence.yml`):
```bash
sudo -E env "PATH=$PATH" MN_MOTO_SERVER="$(command -v moto_server)" SOAK_MINUTES=20 \
  node scripts/medialab/run.mjs --scenarios 'e2e,turn,impair,netchange,failover,lifecycle,authz,multiuser,soak' --work <dir> --out <dir>
```
If your environment cannot provide root/TUN/netns, report the lab as **NOT RUN (environment)** and propose a `workflow_dispatch` run on a pushed branch. You may only trigger it with the owner's approval.

### T5. CI coverage gaps (report and propose; change workflows only on a new branch with owner approval)
- `visual` and `perf` projects are run by no workflow. Decide per test whether it asserts anything (`visual-review.spec.ts` has 9 assertions, incl. UX-6 compact-row rhythm and theme application; `overlay-family`/`perf-probe` are capture tools with 0 assertions; `perf-benchmark` only asserts that samples exist). Propose running the asserting ones.
- `E2E full + media` runs on PRs only for allow-listed head refs (`quality-gate.yml` job `e2e-full`, `if:`). Propose how non-allow-listed PRs get Firefox/WebKit/media/mobile/a11y evidence before merge.
- Weekly-only labs (multinode, media) never run on PRs.

### T6. Remaining conditional skips and excluded files
Re-inventory on the combined tree:
```bash
git grep -nE "\b(test|it|describe)\.(skip|fixme|todo)\b|describe\.skip|it\.skip|\.todo\(" -- '*.ts' '*.js' '*.mjs'
```
Then check the runner exclusions: `e2e/playwright.config.ts` `testIgnore`/`testMatch`, `server/jest*.config.js` `testPathIgnorePatterns`, `client/vitest*.mts`, `jest.mobile.config.js`. Known legitimate gates:
- env-gated PG/Redis/S3 suites (guarded by #157 in CI);
- mobile bundle suites (guarded);
- the Electron Windows-only test (runs on the Windows job);
- Chromium-only WebAuthn;
- link-preview positive path (needs internet).

Confirm each, or report a new one.

### T7. Root-relative stylesheet 404s
A network-traced full chromium run showed 184 requests to 27 root-relative paths (`/tokens.css`, `/modules/*.css`) returning 404. They are order-dependent: 0 in an isolated `a11y.flows.spec.ts` run, and they appeared in 7 a11y.flows tests and 1 cross-browser test. The same files load fine from `/css/…`. Already ruled out: `client/dist/asset-manifest.json` lists `/css/style.css` and `/css/tokens.css` correctly, and neither tests nor client code inline `style.css`. To find the requester, record HAR with snapshots on (`trace: 'on'` **with** `snapshots: true`; without snapshots no network is recorded) and look at the `Referer`/initiator.

### T8. Cloudflare R2 gap
List which behaviours only real R2 can prove (R2-specific auth, public bucket domains, presigned URL behaviour, CORS, eventual consistency, error codes). Map them to what RustFS (CI) and moto (local) prove. Propose an opt-in R2 job that uses owner-provided credentials as secrets. **Do not claim R2 is verified.**

### T9. Validate all five PRs together on an isolated integration branch
Rebuild the integration branch locally (recipe in the checkpoint). Run everything: T2–T4, the server/mobile/PG suites from the checkpoint §3.1, and the client suite `npm run test:svelte:coverage`, Electron (`cd electron && npm test -- --runInBand --forceExit`), bot-sdk (`cd bot-sdk && npx jest --ci`). If you want CI evidence on the combined tree, push the integration branch under a new name (e.g. `integration/five-pr-<date>`) and open a **Draft** PR labelled "integration check — do not merge". Ask the owner first, because it triggers many workflows and the `e2e-full` job only runs for allow-listed head refs. Never merge it.

### T10. Assess issue #133 against every closure criterion
For each criterion in the issue body, write: met / not met / unverified, with evidence (commit SHA, run URL, log excerpt). Account for every test family:
- server Jest, real PG/Redis/S3, pgvector, search, migrations/rollback;
- client Vitest and coverage;
- all Playwright projects;
- Electron, bot-sdk, plugins, discord-shim;
- mobile bridge, Android emulator, iOS simulator (CI reports I07 deep-link as UNVERIFIED and has no WKWebView interaction proof);
- Abuse/Step-up/Federation/media/multinode/self-host labs.

Do **not** close the issue. You may post the assessment as an issue comment if the owner allows; otherwise put it in your report.

### T11. Merge-readiness report and safe merge sequence
Per PR: head SHA, CI on that exact head (run URLs), local evidence, known gaps, interactions with the other four, rollback note. Recommended order to verify (not to execute): **#155 → #157 → #156 → #158 → #159**.
- #155 makes `main`'s nightly green.
- #157 adds guards before more tests land.
- #156 is test-only plus a small route-mount fix.
- #158 changes upload behaviour, so D2/D3 must be fixed first.
- #159 is another agent's security change with the least browser evidence.

Re-check each head's CI and mergeability immediately before recommending it.

### T12. Remaining P7 work (identify only; do not start P8)
From the PRs and docs (`docs/P7_TRUST_SOCIAL_FOUNDATION.md`, #133, #159's `docs/security-audits/2026-10-09-independent-audit.md` "Next priorities"):
- B3 beyond images (logs/telemetry, IP/device records, no backfill of stored files);
- B4 E2EE threat model;
- B5 moderation;
- export/import;
- PG growth and ephemeral lifecycle;
- the step-up lab's OPEN deferred-invite scenario;
- WebAuthn step-up proof in `webauthn-virtual.spec.ts`.

List them with status; **do not implement**.

---

## 3. Verification requirements for anything you push

- Reproduce the original failure (or false green) first, then show the fix, plus a negative control that fails without it.
- Run, with `--retries=0` where applicable:
  - `cd server && npx tsc -p tsconfig.json --noEmit`, `npm run lint`, and the affected Jest suites;
  - `cd e2e && npx tsc -p tsconfig.json --noEmit` and the affected specs;
  - `node scripts/verify-test-ownership.js`;
  - `npm run test:release-integrity`.
- Before each push: `git fetch`, confirm the remote branch did not move, confirm no workflow is queued/in progress (`gh api "repos/fatihcayiroglu/Bridge/actions/runs?status=in_progress"` and `…status=queued`), and push fast-forward only.
- After pushing, wait for CI on the **new head** and report every workflow's conclusion. A red result is yours to root-cause.

---

## 4. Report format (deliver at the end)

1. **State table**: `main` SHA; each PR's head, CI conclusion on that head, mergeability.
2. **Per test family**: exact command, environment (PG version, S3 backend, browser versions, root or not), tested commit/tree SHA, passed / failed / skipped / not-run counts, log location, follow-up.
3. **Defects**: confirmed (with reproduction and negative control) vs suspected (with what is missing).
4. **Changes you made**: branch, commits, Draft PR links, CI run links.
5. **#133 criteria assessment.**
6. **Merge-readiness and sequence** (recommendation only).
7. **Explicit list of everything NOT verified and why.**

Do not summarize vaguely. Do not report an unfinished, skipped or unavailable test as passed.
