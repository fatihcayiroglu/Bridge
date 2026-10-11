# Independent security and test-integrity assessment — 2026-10-09

This assessment confirmed confidentiality failures in semantic history/digest access and hidden presence, and a false-green HTTP-signature acceptance test. The independent fixes below have executable adversarial evidence. This is a repository-wide inventory and targeted assessment, not an exhaustive penetration test or a claim that all security boundaries are proven.

## Repository and collaboration boundary

- Main: `c517364b9289d13e16101a30d080ca51125971a5`, fetched again during verification without a change.
- Isolated checkout: `/workspace/Bridge-security-audit`; branch `security/independent-audit-20261009`. Original `/workspace/Bridge` remained clean.
- Read SECURITY.md, docs/SECURITY-TESTING.md, docs/THREAT_MODEL.md, docs/PRODUCTION.md, the Oct 8 main ledger and Oct 9 ledger in PR 156, issue 133, PR bodies and diffs 155–158, and GitHub Actions HTML.
- PR 155 `c1a72a9a88e85cf4408fa7d8cd82453949cba710`: plugin isolation tests and Firefox warm-up harness.
- PR 156 `062cd18f3aa0a8fd9cc7dab5ece2f9359bed4374`: E2E integrity and voice REST mount.
- PR 157 `d7e148182156eab9f4efffa0df9bce925c179d67`: skip enforcement and ownership wiring.
- PR 158 `39e9504154f2a4572c459d9cd220fef6ee5ead73`: image metadata minimization, including auth/upload-related routes.
- Those are inspected PR-head SHAs, not independent CI success claims. No PR was merged, undrafted, closed or modified. Independent edited production files and the HTTP-signature test do not intersect their inspected diffs. CI can change after this inspection.
- `scripts/abuse-lab/run.mjs` was never edited or staged. SHA-256: `9a28b62eb87e132da7b509ae7aefb66f47292cf199b899ac706d289e05a8a82c`; no diff against main.
- Live proofs use a separate disposable PostgreSQL database `bridge_security_audit`, Redis database 1 and synthetic UUID identities. No production data, external attack, real AI provider or webhook delivery was used.

## Confirmed findings

### F1 — P1 / High: history permission bypass in semantic-derived responses

**Boundary:** access to historical channel content and aggregates requires both VIEW_CHANNELS and READ_HISTORY. ASVS access control; OWASP API1/API5; STRIDE information disclosure.

**Location:** main `server/routes/semantic.ts:356` and its other `viewableChannelIds` calls; fix `server/lib/permissions.ts:489` and all semantic call sites. Existing message history routes enforce the stronger contract.

**Precondition and impact:** Carol is a server member and can view a channel, but her user override denies READ_HISTORY. Semantic keyword search and digest still disclose its historical content; moderator permissions must not imply history access. Bob without membership is a separate refusal control.

**Root cause:** channel visibility alone was treated as permission to read message history. User-specific cache keys cannot repair that boundary.

**Fix:** a dedicated `readableChannelIds` helper requires both permissions, retaining existing administrator semantics and failing closed on resolver failure. Semantic search, cached search, digest and engagement use it; unrelated visibility-only callers remain unchanged.

**Evidence:** new hermetic semantic suite uses real JWT middleware, repositories, permission resolver and cache with an in-memory database; Alice reads the exact synthetic secret, Bob gets exact 403, unauthenticated callers exact 401, Carol gets no history, a moderator stays restricted and an administrator reads. Real PostgreSQL/Redis proof also passes for Alice/Bob/Carol with actual CSRF enforcement. Removing READ_HISTORY from the helper makes 3 of 8 regression tests fail.

**Remaining risk:** full provider-backed vector/AI runs and simultaneous multi-node revocation races were not executed. Engagement's new permission requirement is covered by existing semantic tests, not a new live provider test.

### F2 — P1 / High: stale and deleted content in digest responses

**Location:** main `server/routes/semantic.ts:343` (cache hit before channel/message reads) and the per-channel message query following `:356`; fix `server/routes/semantic.ts:364` and `:422`.

**Precondition and impact:** an authorized member warms a weekly digest, then loses channel visibility or a message is deleted. The old digest can still return content and participation aggregates for 30 minutes. Fresh topMessages also used a less restrictive message query than the AI/aggregate query, exposing deleted or encrypted message payloads.

**Root cause:** cache keys represented caller/parameters/AI setting, not current authorized content; independent aggregate and excerpt queries had different filters.

**Fix:** permission-check and load one current snapshot; exclude deleted, system and E2EE-prefixed rows; derive every aggregate, top message and AI input from it. A SHA-256 fingerprint of channels/messages/display names binds the v2 summary cache. Old keys cannot hit. This preserves caching expensive summaries for unchanged inputs while redoing authoritative reads.

**Evidence:** authorized positive controls precede revocation/deletion tests. Both warmed and fresh responses omit the secret and have zero unauthorized aggregates. Real Redis proof verifies an actual `cached: true` hit before revocation. Replacing the fingerprint with a constant makes 2 of 8 semantic tests fail. The existing digest cache test formerly expected authorization/data queries to be skipped; it now requires those queries before a cache hit.

**Remaining risk:** snapshot reads and permission reads are not one serializable transaction; concurrent mutations during a request need separate race evidence. Snapshot scans have resource cost, particularly the existing 365-day option. Legacy cached confidential bytes expire in Redis; this fix blocks API delivery, not physical Redis erasure or already-delivered copies.

### F3 — P1 / High: cached AI explanations outlive authorization/content

**Location:** main `server/routes/semantic.ts:97`; fix `:102`–`:115`.

**Precondition and impact:** a cached provider explanation quotes a message, then that message is edited/deleted or its channel becomes inaccessible. Revalidating only matches leaves the old free-text explanation in the returned object. Explanations may quote provider inputs that were never returned matches.

**Root cause:** message-level revalidation was mistaken for authorization of an opaque derived artifact.

**Fix:** cached responses use a non-content explanation and current permitted match text. No retained provider prose is delivered from that cache.

**Evidence:** the regression seeds an actual cache entry with synthetic quoted content, revokes access and asserts absence of both matches and quoted explanation. Restoring the cached explanation makes 1 of 8 tests fail; correct code passes. No live AI credentials were used: this proves the cache delivery boundary, not provider behavior.

**Remaining risk:** non-content match metadata is still inherited from cached matches. Broader attachment/edit lifecycle and other provider-derived artifacts need separate controls.

### F4 — P1 / High: hidden presence/activity disclosed through alternate public surfaces

**Location:** main `server/lib/userUtils.ts:48`, `server/routes/activity.ts:178` and `:214`; fix public serializer, activity read before cache, roster filter and activity broadcast payload.

**Precondition and impact:** Alice sets presenceVisibility=hidden. Another authenticated user can read private work/listening activity, including a warm cache; shared-server activity rosters and the public serializer also expose hidden presence fields. The dedicated profile/presence route already masks these fields, making the alternate surfaces inconsistent.

**Root cause:** shared serialization and activity reads lack the canonical visibility rule; cached activity is returned before looking up current privacy.

**Fix:** public serialization masks status/status text/emoji using the canonical normalizer; the owner's serializer explicitly preserves their own fields. Current privacy is checked before cached activity reads, hidden activity is absent from rosters, and broadcast payloads suppress it. The owner still reads/updates their activity.

**Evidence:** 5 initial tests fail on main; final suite has 6 passing controls including visible broadcast and hidden null broadcast. Reverting the production serializer/route in a disposable copy makes all 6 fail. Visible-user and owner controls pass. Socket payload tests use a mocked emitter and do not prove live room delivery.

**Remaining risk:** activity publication uses existing unprefixed room IDs, whereas other server rooms use prefixes; delivery behavior was not changed or proven. This patch does not claim complete cross-node presence transition erasure, cache-at-rest erasure, or revocation of copies already sent to clients. PR 158's auth route was untouched.

### F5 — P2 / Medium: HTTP-signature positive control falsely passes rejection

**Location:** `server/tests/httpSignature.test.ts:585`.

**Claimed contract:** a cryptographically valid HTTP signature with the optional algorithm parameter omitted is accepted with 202. Production explicitly supports that omission.

**Misleading baseline:** the test only asserted `not.toBe(500)`, accepting 401/404. In a disposable copy, change the verifier to reject absent algorithm. The original suite still passes all 31 tests; it no longer demonstrates its advertised acceptance contract.

**Fix and negative control:** require exact 202. Correct verifier: all 31 pass. Same rejection mutation plus corrected assertion: 1 fails, 30 pass. No production signature rule was relaxed. This is a verification defect, not evidence of an authentication bypass.

## Test integrity and discovery

- The textual scan covers 1,066 files / 2,159 candidate lines. Runner ownership covers 1,065 files; the extra scan file is the optional standalone `k6/websocket-cluster-test.js` load harness. These are different scopes.
- `2026-10-09-test-integrity-candidates.json` inventories every matching tracked test source and the new tests, with exact candidate line numbers and PR overlaps. Patterns include broad/conditional statuses, skips, early returns, empty catches and loops. A loop hit does not prove a zero-iteration assertion; comments can match. Counts are reconnaissance, not a count of vulnerabilities. Individual semantic review of every candidate is **not complete**.
- `server/tests/friends-security.test.ts:194` has a redundant `<500`, but also restricts results to 400/404 and asserts no relationship writes. It is not automatically false-green from that one pattern.
- `e2e/tests/webhook-security.spec.ts:137` remains a candidate: a delivery route's `not.toBe(500)` does not prove a delivery result was persisted. Its current production contract returns 200 with `{ok,status,...}`. No fix is claimed: a safe local outbound receiver and persisted-state proof are still needed. Do not send test delivery to third parties.
- A known digest test actively expected cache bypass of authorization reads; corrected as part of F2. Previously cache-disabled semantic visibility tests cannot prove warm-cache revocation. New tests use actual cache entries.
- Mobile first run: 105 passed, 22 skipped because compiled shell inputs were absent. After providing the built client artifacts: 127 passed, 0 skipped. Only the latter is complete local evidence.
- Electron: 50 passed, 1 legitimate Windows-only tray startup test skipped on Linux. Windows workflow ownership exists; its remote result was not independently verified here.
- Existing optional PostgreSQL/Redis suites use conditional describe.skip; their guard work is owned by PR 157. The new live semantic suite throws if either PG_TEST_URL or REDIS_TEST_URL is absent; deliberately missing them produces a failing suite, not a skip or pass.
- Ownership validation reports no orphan/unavailable runners, including new files. Discovery alone is not runtime evidence. The security corpus now includes both new hermetic suites and HTTP-signature contracts. No CI workflow or PR-157 guard was duplicated.

## Boundary inventory and evidence limits

| Area | Inspection/evidence | Remaining uncertainty |
| --- | --- | --- |
| REST, role hierarchy, channels/messages | middleware/auth; permissions; channel/history routes; existing tests plus F1/F2 multi-actor controls | not every mutation has a new no-side-effect negative control |
| Socket.IO, rooms, voice/SFU/TURN | socket authorization, handlers, mediasoup worker/turn configuration; existing Jest suites; live polling handshake and SFU worker startup | no live adversarial media/TURN session or multinode room revocation proof |
| JWT, refresh, logout, step-up, recovery, TOTP/passkeys | token version checks, session revocation, CSRF, auth/2FA/passkey/step-up test suites; real concurrency suite during setup | no complete end-to-end recovery/passkey authenticator run; JWT algorithm policy remains a hardening review item, not a proven bypass |
| DM/GDM, inbox, saved items, notifications | membership/ownership paths, saved/inbox reauthorization and existing suites | complete live cross-path DM/notification revocation matrix not executed |
| Search/AI/embeddings | semantic and summarize routes, AI server opt-out, cache/vector invalidation; new semantic proofs | external providers and real pgvector extension not run |
| Protected uploads/images | uploadAuthz and storage/reference safety; existing tests; PR 158 overlap intentionally preserved | real S3 boundary suite not run locally; metadata fixes await PR review |
| Federation/ActivityPub | HTTP signatures and replay binding, actor/key ownership, guarded fetch/delivery routes; F5 verifier controls | no hostile live federation peer; remote issuer interoperability not proven |
| Plugins/bots/webhooks | plugin action permissions, bot ownership, outgoing URL checks/queue; existing suites; PR 155 preserved | live plugin-browser isolation and safe local webhook delivery need additional proof |
| SSRF/XSS | ssrfGuard DNS/IP classifier and fetch connection policy; rendering sanitizers; existing suites | WebPush performs public-URL validation before a library-owned connection: rebinding resistance needs a controlled DNS experiment, not a confirmed exploit here |
| Client/offline/E2EE | local-first operation ownership, encrypted per-user runtime/operation log and renderer paths; full client suite | native keychain loss, two-account hardware lifecycle and malicious renderer tests not executed |
| Electron/mobile | sandbox/context isolation/navigation/IPC guards, Capacitor settings; Electron and built mobile suites | mocked native APIs do not establish installed-device or OS packaging security |
| Jobs, telemetry/logs, deployment, backups | scheduled delivery/push/reaper paths, logger/requestContext, Docker production hardening, backup and restore scripts, Actions workflows; release-integrity suite | logger lacks centralized Pino redaction; this is a hardening candidate, no real credential leak shown. Backup script creates gzip dumps/rsync copies with no application encryption; deployment encryption/ACLs/S3 policy require operator evidence |

Additional candidate: `server/routes/voicemsg.ts:257` authorizes channel/history before returning a VoiceMessages transcript, but does not visibly check a linked message's deletion state. Upload creation stores URL linkage, not messageId. Establish real delete/transcription lifecycle and retained-row behavior before classifying this as a confirmed disclosure; no claim or unverified fix is made.

## Verification and operational limits

Executed results: full server **624 suites / 12,011 tests, zero skips**; security corpus **47 suites / 806 tests, zero skips**; client **318 files / 5,403 tests**; built mobile **127 tests, zero skips**; Electron **50 pass / 1 Windows-only skip**; new real PG/Redis/CSRF **3 tests**; zero-retry Playwright API smoke **3 tests**. Setup separately verified 182 release-integrity tests and 18 live concurrency/Redis tests. Server typechecks, test-strict debt check, lint and build pass. Client typecheck passes.

See `2026-10-09-independent-evidence.json` for final counts, result hashes and source hashes. Raw local execution output remains under `/workspace/.bridge-env/`. PASS rows are executed results; expected failing mutations and missing-env runs are marked separately. No missing integration is substituted with a mocked PASS.

Useful commands (activate the pinned Node first):

```sh
export PATH=/workspace/.bridge-env/tools/node-v24.20.0-linux-x64/bin:$PATH
cd /workspace/Bridge-security-audit/server
npm test
npm run test:security
npm run typecheck
npm run lint
PG_TEST_URL=postgresql://bridge@127.0.0.1:55432/bridge_security_audit REDIS_TEST_URL=redis://127.0.0.1:56379/1 npx jest --config jest.pg.config.js --runInBand --runTestsByPath tests/pg-integration/semantic-confidentiality.pgtest.ts
```

- Targeted Playwright API smoke ran with retries=0 and a separate minimal config without browser/global account setup; it proves main's disposable running instance, not browser authorization or the new compiled fixes. Three API smoke tests pass. Readiness itself was separately required to be 200/ok by the environment smoke helper.
- Browser download is blocked by network policy: cdn.playwright.dev returns `403 Domain forbidden`. Browser security E2E is **NOT RUN**.
- GitHub API access is blocked by policy; exact-head CI status and current workflow completion are **UNVERIFIED**. PR body claims are not independent CI evidence. No push or draft PR creation is claimed. Local focused commits and reviewable PR body drafts are the delivery artifacts.
- Live S3, pgvector, full federation/media labs, installed native platforms and external providers are **NOT RUN**. Existing unit PASS does not elevate them to live PASS.
- Existing tests run without introduced skips/retries. Mutations are only in a disposable copy, never another agent's checkout.
- Environment setup installs Node 24.20.0 and a verified official mediasoup worker, starts local PostgreSQL/Redis, and builds in a disposable copy so original tracked HTML remains unchanged. Setup/start instructions and additive api.github.com, cdn.playwright.dev and storage.googleapis.com domains are saved in the environment draft. Saving does not publish or apply networking; settings require review/save and Publish.

## Focused local delivery

| Commit | Scope |
| --- | --- |
| `161aa969e4354c512e4dd4ec4ff18046b1a914fa` | F1–F3 semantic confidentiality and live/hermetic regressions |
| `5dae3293726cca4f245c05e165da925a868c044a` | F4 hidden public presence/activity |
| `a97a481f0cabed156855cc0c06db4283b417b8ac` | F5 exact HTTP-signature acceptance assertion |
| `274d270df0c55079a5993e6170bd70e2d2f949c7` | Register the new tests in the security corpus |

Prepared independent PR descriptions are in `pr-drafts/`. Source commits can be cherry-picked separately from main; corpus registration references the new tests and follows those packages. No remote branches or PRs were created. The evidence ledger binds the validated source to the fourth commit by per-file hashes; the following report commit changes only documentation.

## Next priorities

1. Apply the draft's needed domains, recheck PR-head CI/activity, run zero-retry browser security E2E on a separate disposable application, and open focused draft PRs after overlap verification.
2. Execute safe local transcript-delete and webhook persistence controls, provider-derived artifact revocation, and full REST/socket/cache/notification cross-path confidentiality matrices.
3. Run real S3/pgvector and multinode revocation/outage evidence; review snapshot resource bounds and concurrent permission/content changes.
4. Review centralized log redaction and encrypted backup/restore/retention policy against actual operator deployment. Continue line-by-line adjudication of candidate tests with PR 157's guards.
