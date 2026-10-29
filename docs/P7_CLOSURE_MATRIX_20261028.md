# P7 closure matrix (2026-10-28) — evidence-backed, not a completion claim

**State: OPEN.** Replaces the status columns of `P7_FINAL_CLOSURE_LEDGER_20261016.md` for the rows below; the contract text stays in `P7_TRUST_SOCIAL_FOUNDATION.md`.
Main at audit time: `c061d72f`. Rows cite only runs and commits that were read on 2026-10-28; anything not re-read says so. **Nothing unexecuted is PASS.**

**2026-10-29 update:** the original rows below retain historical evidence where
not explicitly updated. The exact-head reconciliation in §7 supersedes stale
head/CI status. This independent branch preserves #575 and merges #574's history;
it does not merge or deploy either to production main.

**Evidence quality:** `A` exact-head CI job read for the cited SHA · `B` scheduled run on `main` for the cited SHA · `C` local test only (no CI on that head yet) · `D` documented only / not re-verified today · `—` none.

## 1. Gates on `main` (`c061d72f`)
| Requirement | Owner | Evidence | Result | Q | Remaining blocker / owner decision |
|---|---|---|---|---|---|
| Quality Gate (typecheck, unit/integration, E2E, Docker, Playwright) | [#574](https://github.com/fatihcayiroglu/Bridge/pull/574) | Scheduled [run 40650973382](https://github.com/fatihcayiroglu/Bridge/actions/runs/40650973382) job 122690694994: **Security audit FAIL** at "Audit root/workspaces"; the other 8 jobs **skipped** (not passed). Also red in runs 40463745017, 40283869386, 40171190279, 40070737768. | **FAIL** (8 jobs NOT EXECUTED) | B | Advisories published after #363 (undici, body-parser, qs, multer, nodemailer, fast-uri, Electron runtime). #574 head `9f9705ed`: exact-head CI **18/19 success, 1 skipped (E2E full + media), 0 failed**, including Security audit (job 123137662566), Unit and integration, Windows/macOS/Linux Electron on 42.11.18. Scheduled `main` stays red until #574 is merged. |
| Dependency audit, lockfile reproducibility | #574 | `npm audit --audit-level=high` exit 0 in all four trees and `npm ci` OK in three (local), Security audit job green on the exact head; 6–7 **low** `deepmerge` findings remain | PASS at high | A | #536 (vendored deepmerge) is an owner decision. |
| Mobile Android (emulator) | — | Scheduled [40668431675](https://github.com/fatihcayiroglu/Bridge/actions/runs/40668431675) success. An earlier scheduled run, [40177610041](https://github.com/fatihcayiroglu/Bridge/actions/runs/40177610041), failed. | PASS (this run) | B | Intermittency is #209; one green run is not a root-cause fix. |
| Mobile iOS (build/simulator) | — | Scheduled [40669044712](https://github.com/fatihcayiroglu/Bridge/actions/runs/40669044712) success | PASS (build/sim) | B | Not the system-browser journeys; see §3. |
| Federation + AI, Self-host, Multi-node, Media, Abuse Lab, Step-up Lab | — | Scheduled success: [40673083354](https://github.com/fatihcayiroglu/Bridge/actions/runs/40673083354), [40479967132](https://github.com/fatihcayiroglu/Bridge/actions/runs/40479967132), [40295250678](https://github.com/fatihcayiroglu/Bridge/actions/runs/40295250678), [40485237274](https://github.com/fatihcayiroglu/Bridge/actions/runs/40485237274), [40485427485](https://github.com/fatihcayiroglu/Bridge/actions/runs/40485427485), [40490462880](https://github.com/fatihcayiroglu/Bridge/actions/runs/40490462880) | PASS | B | Scheduled evidence on `c061d72f`; not a PR exact-head result. |
| Android upstream WebView diagnostics (non-gating) | #209 | [40672661539](https://github.com/fatihcayiroglu/Bridge/actions/runs/40672661539) failure (also 40483241710, 40304160057) | FAIL (non-gating) | B | Evidence for #209; not read in detail today. |

## 2. Pillars A–D
| Item | Owner | Evidence | Result | Q | Remaining blocker / owner decision |
|---|---|---|---|---|---|
| A1–A7 local-first foundation | #124 | Ledger: foundation merged, exact-head `ac021863` | PASS (foundation) per ledger | D | Re-run offline/account-isolation acceptance on final main. |
| B1 anti-raid/spam/ingress parity | #295–#307 | Ledger: 2026-10-19 audit found four bypasses; fixes on `claude/bridge-android-reliability-c246r2`, unmerged | OPEN | D | Homoglyph (NFKC) evasion, timed-out members voting/reacting: product decisions. |
| B2 risk-adaptive security | — | Ledger: evidence reconciliation not done | OPEN | D | Enumerate sub-items and link runnable tests. |
| B3 metadata minimization | #312 | Ledger: merged `4371521d`, Quality Gate [38948013072](https://github.com/fatihcayiroglu/Bridge/actions/runs/38948013072) success (client-error path only) | PARTIAL | D | Other logging/telemetry, access/export/deletion not audited. |
| B4 E2EE | #309/#310/#313 | Ledger: no E2EE protocol claimed (truthful capability only) | OPEN | D | Cryptosystem missing; separate project. |
| **B5 evidence-safe reports (#336)** | [#572](https://github.com/fatihcayiroglu/Bridge/pull/572) `c6f3aac7` | Exact-head Quality Gate 40780602926 and all six other workflows PASS; see §7. Flag **off by default** | **IMPLEMENTED SUBSET, CI PASS** | A | Owner decisions remain: retention after resolve, erasure precedence, legal hold, hard-delete cascade and enablement. Feature-enabled browser E2E and production-size performance remain unqualified. |
| C1 identity export | #181 | Ledger: bounded profile subset PASS | PASS (subset) | D | — |
| C2–C3 community export/import | #205, #233–#243 | Issue #205: merged existing-row metadata-only apply; P7-RT-01..22 and P7-ROT-01..05 in a two-installation HTTPS lab | PASS for the **supported subset only** | D | Users, memberships, history, files, E2EE keys and new grants stay **unsupported**; scope decision (#205). |
| C4 cross-installation restore | #205 | Lab only | OPEN | D | Production DNS/operator authenticity, scope decision. |
| D1 partition decision | #319 | Ledger: read-only collector; no live measurements | OPEN | D | Measure on representative data; a documented no-partition decision is acceptable. |
| D2 ephemeral channels (#321) | #325, [#576](https://github.com/fatihcayiroglu/Bridge/pull/576), [#578](https://github.com/fatihcayiroglu/Bridge/pull/578) | Schema 084 inert foundation; #576 `104b6044` socket preflight, exact-head QG 40780241603 PASS; #578 `a6323aa1` adds schedule/dispatch checks and dedicated PG16/Redis verification | **PARTIAL, OPEN** | A/C | No expiry activation API; other write paths and atomic write fence OPEN. Cleanup graph, real reconnect/process restart and federation not qualified. See `P7_D2_SCHEDULED_WRITE_AUDIT_20261029.md` on #578. |
| D3 migration safety | — | Today: rollback gate `verify-migration-rollback.js --ordered` on a disposable PostgreSQL 16 is green after a classification update for 085 (local) | PARTIAL | C | Per-migration lock/runtime evidence and backup-restore not collected. |

## 3. Native authentication (P7 mobile)
| Requirement | Owner | Evidence | Result | Q | Remaining blocker / owner decision |
|---|---|---|---|---|---|
| Android Custom Tabs: cancel, authenticate/restart/rotate, switch/isolate/revoke/restart | [#548](https://github.com/fatihcayiroglu/Bridge/pull/548) `23818207` | [Run 40766292930](https://github.com/fatihcayiroglu/Bridge/actions/runs/40766292930) job 123091219612: `passed 3, failed 0, notExecuted 0, skipped 0`, first attempt, emulator API 35 | **PASS 3/3** | A | Emulator-only; API 24/36/37 and physical devices not covered. Switch relies on the new web "Use a different account" button. |
| Real PostgreSQL 16 + Redis integration of native auth | #548 / #553 heads | `real-backend` success on `23818207` (job 123091220444) and on `2b73f200` (job 123101961352) | PASS | A | — |
| iOS system browser: cancel | [#553](https://github.com/fatihcayiroglu/Bridge/pull/553) `aa4ae68f` | [Run 40785140974](https://github.com/fatihcayiroglu/Bridge/actions/runs/40785140974) job 123156324910: case 1 PASS; artifact inspected and SHA-256 verified | PASS (this case/run) | A | Simulator iOS 18.5; not physical/minimum-version coverage. Prior 40774768212 and failures retained. |
| iOS: authenticate/restart/rotate | #553 `aa4ae68f` | Same run: case 2 FAIL. Captured failing command is **`mobile: keys`, POST `/execute/sync`, HTTP 500 unknown error**; cleanup `mobile: activeAppInfo` is not the failing command. | **FAIL** | A | Native command attribution established, underlying driver/input cause still OPEN. No credentials or native input values reproduced. |
| iOS: switch/isolate/revoke/restart | #553 | Not reached in any run | **NOT EXECUTED** | — | Depends on case 2; Safari cookie sharing with ASWebAuthenticationSession unverified. |
| Android API 37 | #549, #552 | SDK package unavailable; cell red by owner decision | **NOT EXECUTED** | — | Never substituted; blocked on SDK availability. |
| Physical Android / iOS devices | — | None | **NOT EXECUTED** | — | Needs hardware. |
| Redirect interception, token storage, reinstall behavior | [#530](https://github.com/fatihcayiroglu/Bridge/pull/530), [#533](https://github.com/fatihcayiroglu/Bridge/pull/533), [#537](https://github.com/fatihcayiroglu/Bridge/pull/537) | Draft PRs with findings and server half; no device evidence | OPEN (drafts) | C/D | **Owner decisions:** callback domain, signing-certificate fingerprint, Apple Team ID (#537); fresh install starts signed out? (#533); findings 2–4 of #530. |

## 4. Platform and performance acceptance
| Requirement | Owner | Evidence | Result | Q | Remaining blocker |
|---|---|---|---|---|---|
| Linux packaged app, native Wayland | [#416](https://github.com/fatihcayiroglu/Bridge/issues/416), [#573](https://github.com/fatihcayiroglu/Bridge/pull/573) `71abbd71` | First failures 40110110689, 40076533049 retained. Diagnostic PR exact-head Desktop 40782115427 and QG 40782115422 PASS. | **OPEN** | A | Diagnostic success is not a causal fix; require evidence from an actual failing native-Wayland run. No X11 substitution/sandbox relaxation. |
| Windows / macOS packaging and runtime, Linux X11 | #415 | Per issue #416: passed on `6dab3452`; not re-read today | PASS per issue | D | Re-verify on final main. |
| Android ANR / process death (#209) | #209 | Original failures preserved in the issue; later greens are non-reproduction | **OPEN** | D | Targeted ActivityManager evidence, physical device. |
| Real-product desktop performance (#570): idle, 2/5/10 voice, gaming + voice + screen share, 10k messages, 1080p60, 1440p/4K, soak, degradation | [#577](https://github.com/fatihcayiroglu/Bridge/pull/577) `38e6f198` | Contract/harness exact-head QG 40783278478 and other five workflows PASS. **Every real scenario remains NOT EXECUTED.** | **NOT EXECUTED** | — | Implement packaged idle and genuine 10k-history executors first. Gaming/capture/SFU require actual hardware and participants; synthetic #569 is not acceptance. |
| Voice/video/screen-share acceptance | #570 | Media Evidence scheduled success [40485237274](https://github.com/fatihcayiroglu/Bridge/actions/runs/40485237274) (what it covers was not re-read today) | PARTIAL | B | Real devices, real capture. |

## 5. Owner decisions, in one place
1. **#336** retention days (rec. 30 after resolve), open-report vs erasure (rec. keep until resolved, then scrub), legal hold, hard-delete cascade, flag in production.
2. **#537** callback domain, Android release certificate SHA-256, Apple Team ID.
3. **#533** fresh install starts signed out (PR implements yes).
4. **#530** findings 2 (unused scheme), 3 (step-up for native authorization), 4 (device-bound refresh).
5. **#536** vendored `deepmerge` (low severity; the gate does not fail on it).
6. **#205** is the supported metadata-only portability subset enough for P7?
7. **Native account switch:** owner already approved the isolated native flow (#559/#560), preserving the browser's existing account. #548's separately verified "Use a different account" flow changes browser identity and must not silently replace that approved architecture. Its API35 emulator result is implementation-specific evidence, not approval of a different session policy.

## 6. What would make P7 closable
Green exact-head Quality Gate on `main` (needs #574 merged); iOS cases 2 and 3 genuinely passing; API 37 executed or the owner accepting NOT EXECUTED; physical-device evidence or an explicit decision that it is a release gate rather than a P7 gate; D2 built beyond the inert foundation; B5 decisions plus CI; real-product desktop performance on actual hardware; #416 root-caused.

## 7. Exact-head reconciliation (read 2026-10-29)

| PR | Exact head | Verified workflow evidence | Result and limit |
| --- | --- | --- | --- |
| #572 | `c6f3aac7b5ad11d57824f8e427957c204565d11c` | QG 40780602926; Desktop 40780602776; Federation 40780602850; Self-host 40780602805; iOS 40780602793; Android 40780602770; Step-up 40780602832 | All seven workflows PASS. Feature-off/report subset only; owner gates above stay OPEN. |
| #573 | `71abbd717b310c95c8f79d07edc3887ccf09e7f3` | QG 40782115422; Desktop 40782115427; Self-host 40782115426; Federation 40782115455; iOS 40782115437; Android 40782115425 | All six PASS; #416 not fixed by non-reproduction. |
| #574 | `9f9705ed4b01cbf8670ba469cb9bd5d57f6dead2` | QG 40779617350; Desktop 40779617502; Android 40779617444; iOS 40779617509; Federation 40779617448; Self-host 40779617557 | All six PASS. QG eight jobs PASS; nightly-only conditional job 123143497187 not scheduled. Do not count a conditional job as a skipped product test. |
| #575 original | `449e0c7718a1816c8bfb93bf2fcd4dd3e8052ef5` | QG 40779781072, audit job 123138210819 FAIL: 13 findings (7 low, 3 moderate, 3 high), including vulnerable undici | Did not inherit #574. Other eight jobs not executed/conditional. Original failure retained; this child branch merges #574 without rewriting #575. Child exact-head CI pending. |
| #576 | `104b60447b7ac69392994f5cc04c0c3153408538` | QG 40780241603; Federation 40780241604; Abuse 40780241583; iOS 40780241592; Self-host 40780241556; Android 40780241626; Desktop 40780241562 | All seven workflows PASS. Eight QG jobs PASS, nightly-only 123147618031 conditional. Inherits #574. Socket preflight subset, not whole D2. |
| #577 | `38e6f198e7757d2f1f909e3f293b3b541855da5d` | QG 40783278478; Desktop 40783278423; Android 40783278480; iOS 40783278472; Self-host 40783278449; Federation 40783278657 | All six PASS. Inherits #574; no real performance scenario executed. |
| #553 | `aa4ae68fa4c66802c92c6d3db33bc3de4b848df0` | Browser 40785140974 FAIL (job 123156324910); native binary 40785140723 PASS; pilot checks 40785140783 PASS; backend PG16/Redis 40785140699 PASS | Browser 1 PASS / 1 FAIL / 1 NOT EXECUTED. Binary/Node/backend success cannot substitute for browser acceptance. |
| #578 | `a6323aa1fdf27e950ddb590b4a31b5c4966c434c` | Dedicated PG16/Redis run 40788727299, job 123168323163 PASS, first attempt; PostgreSQL 160015 / Redis PONG; **7/7 tests, zero skipped** | Local 97/97 PASS, strict types/build PASS. Stacked on #576; retains #574 history. Worker-level real-service subset only; D2 acceptance remains OPEN. |

The #553 original artifact is preserved locally as
`bridge-p7-ios-40785140974.zip`, SHA-256
`6e082b6b0e76b2caea77e216f0715fa879cb6010182328923bd39ac3dc0f82a3`.
Only closed diagnostic fields were inspected for attribution; no authentication
values are included here. No failed acceptance run was rerun for a green result.

Main remains `c061d72fee43a23a068a86c6d8f9726c44ad6f41` at recovery time.
Successful draft-branch evidence does not fix production main until an explicitly
authorized, independently qualified integration. No merge or deploy authorized.

This child also fixes the observed Windows-only no-skips CLI self-test failure:
native `path.relative` emitted backslashes while the documented/tested diagnostic
uses slash separators. Canonicalize only the displayed path; exit codes and
zero-skips/zero-collected assertions are unchanged. Original local run: 5 PASS /
1 FAIL / 0 skipped; retain that failure. Cross-platform CI is added alongside
four independent locked-graph audits (root/server/Electron/E2E). Local audits all
exit 0 at the existing high threshold: zero moderate/high/critical, with low
findings still 7/6/6/0 respectively. This is not a zero-vulnerability claim, nor
does lockfile audit by itself prove installation/runtime compatibility.

The reconciliation preserves Claude commit `0dec6400cb4ac817949be160e7f0814a77665041` in history. Its additional observations remain historical evidence: #572 local report tests 11 and local PG16 migration tests 5/5; prior iOS failures 40779920476 (`b884c80a`) and 40782641256 (`b0cecdac`); #573 job 123146241077 observed Weston 14.0.2 with no `wl_seat` and `xdg_wm_base` v5 while the native window passed. A missing seat alone therefore does not establish the earlier failure cause. These imported local/historical observations were not independently re-executed here.

#553 advanced independently to `5b0656084ac52e8669aff29afe849fc5cb6fe37c` during recovery. The `aa4ae68f` failure above remains exact-head historical evidence; the new head needs separate first-attempt results. Its typing work is preserved and is not duplicated on this branch.

## 8. Implementation checkpoint — 2026-10-29 (supersedes earlier current-status rows)

All PRs below remain draft and unmerged. Main remains unchanged. Do not attach
parent/earlier-head results to a newer head or equate subset CI with P7 closure.

| Requirement | Implementation/head | Exact evidence | Acceptance state |
| --- | --- | --- | --- |
| Scheduled expiry preflight | #578 `ac756d901d5fe48861481ed99f3eb4800ddcb0e1`, base #576 | Run 40789715107 / job 123171605660 PASS: 97/97 unit + 7/7 actual PG16/Redis, zero failed/skipped; types/strict types/build PASS; PG 160015, Redis PONG | Verified subset. Atomic check/write race, other producers and full D2 OPEN. Prior 2017f242 / 40789305382: 90 PASS, 7 FAIL, zero skipped, PG steps NOT EXECUTED; unit fixture incorrectly configured unconnected Redis authority. Original failure retained; real Redis gate unchanged. |
| Voice expiry preflight | #581 `e7c5e386e3d795197e87c347a69e438cde33f78b`, base #578 | First attempt 40791289811 / job 123176851972 PASS: 8 unit suites / 140 tests + 8/8 actual PG16/Redis tests, zero failed/skipped; types/strict types/build PASS | Actual authenticated multipart HTTP expiry refusal with real auth middleware and signed fixture JWT. No file/DB row on expired channel. No interactive login, native audio/codec or durable object-cleanup claim; atomic race remains OPEN. |
| Closure ancestry + portable no-skips CLI | #579 qualified `4f51c38daccc4543e1449ba102670c9a32ae77de` | First attempt 40789254214: four locked-graph audit jobs 123170077936/950/970/8020 and Windows/Linux CLI jobs 123170077905/648 PASS | Retains #574 and Claude #575 commit 0dec6400 in history. Low findings remain (7/6/6/0); not zero vulnerabilities. This subsequent matrix update needs its own first CI. |
| Original #575 latest state | `0dec6400cb4ac817949be160e7f0814a77665041` | QG 40787731090 / audit 123165041501 FAIL: 13 findings (7 low, 3 moderate, 3 high); other eight jobs NOT EXECUTED/conditional | Original still lacks #574; child #579 does not rewrite it or make production main green. Original 449e0c77 failure also retained. |
| Packaged idle/history executor | #580 `36e556116789ffcc6d3d898dbee2768cdfdd053f`, base #577 | Real Svelte/backend/DEB build and 10000-row PG16 fixture achieved on earlier executor heads; actual PA01/PA08 measurements still NOT EXECUTED at checkpoint | New exact-head runtime CI pending. First failures: 1604a53f / 40790339178 installed-app/sandbox assertion; c6e132d5 / 40790877387 legacy members._id fixture; 263db217 / 40791304645 missing mandatory production METRICS_SECRET. Fixes retain assertions, provision real sandbox, use migrated composite membership, supply secret and keep TLS/auth/60s startup bound. Eight gaming/media scenarios stay NOT EXECUTED. |
| iOS browser prerequisites | #553 previous `5b0656084ac52e8669aff29afe849fc5cb6fe37c` | Run 40788142507 / job 123166389549 FAIL at native-xcuitest-session: ABORT_ERR, no cases, **0 PASS / 0 product FAIL / 3 NOT EXECUTED** | Driver deadline 480000ms. Before-input Appium evidence has repeated ECONNREFUSED on loopback WDA port 8100; XCTest starts near the deadline. No causal fix established and no timeout increase/rerun. Binary 40788142487, pilot 40788142419, backend 40788142432 PASS cannot replace native journeys. |
| iOS latest independent work | #553 advanced to `ff31737b150cbb9e85c59fbb41c20dc05727bef8` | New exact-head results require separate inspection | Claude's work preserved; not duplicated/overwritten. The aa4ae68f and 5b065608 failures stay historical. |

The four audit job IDs above in full are 123170077936 (E2E), 123170077950
(root), 123170077970 (Electron), 123170078020 (server); CLI 123170077905
(Windows), 123170077648 (Linux). These audit the locked graph, not installed
runtime parity on every OS.

Hash-verified originals preserved locally (artifact names, no credentials):

- 40789715107 artifact 12860728261: SHA-256
  `3f9a6b2901513d58157a90113fc56ab4c23df7356c3e1ae939c4cb56601ee466`.
- 40791289811 artifact 12860929333: SHA-256
  `bdd50555fb64514909890ce4c735e799c87d074a51a608d99d9b3b0854009ff3`.
- Original unit failure 40789305382 artifact 12860204102: SHA-256
  `74fab4a4a8446da8d647620c079ced931e97741c768a5c5dd0e195da98221423`.
- iOS 40788142507 artifact 12861496495: SHA-256
  `cebe6a0d279545df0d92ba8ec7eae9bcc3fa7213dca282a4c36ecf030207a8b0`.
- #416 original 40110110689 Linux package artifact 12566661109: SHA-256
  `7b63c63b18c2bb1c1d454f50094021864e15eefac77ed951f19453f175dc9e4a`.
  Preserved before its hosted 2026-10-31 expiry. It is a first-failure package,
  not a reproduced/fixed Wayland result.

#209 remains OPEN: original HOT/COLD and ANR failures are not superseded by a
later emulator green or new RN auth test. #416 remains OPEN: seat absence can
explain GTK warnings but is not proven to cause the missing toplevel. Perf X11
execution is separate from native Wayland acceptance. Physical devices/API37,
real gaming/SFU/capture and startup SLA acceptance remain NOT EXECUTED without
their own evidence. Retention/erasure/legal-hold, signing domains/identities and
release-scope decisions remain with the owner; no choice is silently enacted.
