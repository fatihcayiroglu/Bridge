# P7 closure matrix (2026-10-28) — evidence-backed, not a completion claim

**State: OPEN.** Replaces the status columns of `P7_FINAL_CLOSURE_LEDGER_20261016.md` for the rows below; the contract text stays in `P7_TRUST_SOCIAL_FOUNDATION.md`.
Main at audit time: `c061d72f`. Rows cite only runs and commits that were read on 2026-10-28; anything not re-read says so. **Nothing unexecuted is PASS.**

**Evidence quality:** `A` exact-head CI job read for the cited SHA · `B` scheduled run on `main` for the cited SHA · `C` local test only (no CI on that head yet) · `D` documented only / not re-verified today · `—` none.

## 1. Gates on `main` (`c061d72f`)
| Requirement | Owner | Evidence | Result | Q | Remaining blocker / owner decision |
|---|---|---|---|---|---|
| Quality Gate (typecheck, unit/integration, E2E, Docker, Playwright) | [#574](https://github.com/fatihcayiroglu/Bridge/pull/574) | Scheduled [run 40650973382](https://github.com/fatihcayiroglu/Bridge/actions/runs/40650973382) job 122690694994: **Security audit FAIL** at "Audit root/workspaces"; the other 8 jobs **skipped** (not passed). Also red in runs 40463745017, 40283869386, 40171190279, 40070737768. | **FAIL** (8 jobs NOT EXECUTED) | B | Advisories published after #363 (undici, body-parser, qs, multer, nodemailer, fast-uri, Electron runtime). #574 clears every `high` locally in root/server/electron/e2e; exact-head CI pending. |
| Dependency audit, lockfile reproducibility | #574 | Local: `npm ci --ignore-scripts` OK in root, server, electron; `npm audit --audit-level=high` exit 0 in all four; 6–7 **low** `deepmerge` findings remain | C | C | #536 (vendored deepmerge) is an owner decision. |
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
| **B5 evidence-safe reports (#336)** | [#572](https://github.com/fatihcayiroglu/Bridge/pull/572) `347044a5` | Local: report-evidence 11 tests (real routes, in-memory DB), real PostgreSQL 16 migration test 5/5, rollback gate `--ordered` green, client 5576 tests; flag **off by default** | **IMPLEMENTED, NOT VERIFIED IN CI** | C | **Owner decisions:** retention after resolve, erasure precedence for open reports, legal hold, hard-delete cascade, enabling the flag (see `P7_B5_REPORT_EVIDENCE.md`). |
| C1 identity export | #181 | Ledger: bounded profile subset PASS | PASS (subset) | D | — |
| C2–C3 community export/import | #205, #233–#243 | Issue #205: merged existing-row metadata-only apply; P7-RT-01..22 and P7-ROT-01..05 in a two-installation HTTPS lab | PASS for the **supported subset only** | D | Users, memberships, history, files, E2EE keys and new grants stay **unsupported**; scope decision (#205). |
| C4 cross-installation restore | #205 | Lab only | OPEN | D | Production DNS/operator authenticity, scope decision. |
| D1 partition decision | #319 | Ledger: read-only collector; no live measurements | OPEN | D | Measure on representative data; a documented no-partition decision is acceptable. |
| D2 ephemeral channels (#321) | #325 | Merged `d093ac7e`: schema 084 + tombstone table, **inert**, no expiry activation | FOUNDATION ONLY | D | Authorization/read-write denial, worker lease, cleanup graph, offline/federation: not built. |
| D3 migration safety | — | Today: rollback gate `verify-migration-rollback.js --ordered` on a disposable PostgreSQL 16 is green after a classification update for 085 (local) | PARTIAL | C | Per-migration lock/runtime evidence and backup-restore not collected. |

## 3. Native authentication (P7 mobile)
| Requirement | Owner | Evidence | Result | Q | Remaining blocker / owner decision |
|---|---|---|---|---|---|
| Android Custom Tabs: cancel, authenticate/restart/rotate, switch/isolate/revoke/restart | [#548](https://github.com/fatihcayiroglu/Bridge/pull/548) `23818207` | [Run 40766292930](https://github.com/fatihcayiroglu/Bridge/actions/runs/40766292930) job 123091219612: `passed 3, failed 0, notExecuted 0, skipped 0`, first attempt, emulator API 35 | **PASS 3/3** | A | Emulator-only; API 24/36/37 and physical devices not covered. Switch relies on the new web "Use a different account" button. |
| Real PostgreSQL 16 + Redis integration of native auth | #548 / #553 heads | `real-backend` success on `23818207` (job 123091220444) and on `2b73f200` (job 123101961352) | PASS | A | — |
| iOS system browser: cancel | [#553](https://github.com/fatihcayiroglu/Bridge/pull/553) `39a18bea` | [Run 40774768212](https://github.com/fatihcayiroglu/Bridge/actions/runs/40774768212) job 123121050022: case 1 PASS (first attempt) | PASS (1 run) | A | One run; earlier heads failed before reaching it. |
| iOS: authenticate/restart/rotate | #553 | Same run: **FAIL** `MOBILE_AUTH_DEADLINE:system-authentication-browser` (3 visible web views, "Cancel" present, no login label). Earlier: password typed into the username field (run 40725593481); WDA start 227.9 s (run 40769336956) | **FAIL** | A | Cause not established; `mobile: keys` typing still untested; head `7e4a0da2` adds label diagnostics. |
| iOS: switch/isolate/revoke/restart | #553 | Not reached in any run | **NOT EXECUTED** | — | Depends on case 2; Safari cookie sharing with ASWebAuthenticationSession unverified. |
| Android API 37 | #549, #552 | SDK package unavailable; cell red by owner decision | **NOT EXECUTED** | — | Never substituted; blocked on SDK availability. |
| Physical Android / iOS devices | — | None | **NOT EXECUTED** | — | Needs hardware. |
| Redirect interception, token storage, reinstall behavior | [#530](https://github.com/fatihcayiroglu/Bridge/pull/530), [#533](https://github.com/fatihcayiroglu/Bridge/pull/533), [#537](https://github.com/fatihcayiroglu/Bridge/pull/537) | Draft PRs with findings and server half; no device evidence | OPEN (drafts) | C/D | **Owner decisions:** callback domain, signing-certificate fingerprint, Apple Team ID (#537); fresh install starts signed out? (#533); findings 2–4 of #530. |

## 4. Platform and performance acceptance
| Requirement | Owner | Evidence | Result | Q | Remaining blocker |
|---|---|---|---|---|---|
| Linux packaged app, native Wayland | [#416](https://github.com/fatihcayiroglu/Bridge/issues/416), [#573](https://github.com/fatihcayiroglu/Bridge/pull/573) | First failures: 40110110689, 40076533049 (no `xdg_toplevel` in 60 s). #573 adds read-only diagnostics, assertions unchanged (local contract test 5/5) | **OPEN** | C | Cause unverified; needs the next failing run's `WAYLAND_DIAG` output. |
| Windows / macOS packaging and runtime, Linux X11 | #415 | Per issue #416: passed on `6dab3452`; not re-read today | PASS per issue | D | Re-verify on final main. |
| Android ANR / process death (#209) | #209 | Original failures preserved in the issue; later greens are non-reproduction | **OPEN** | D | Targeted ActivityManager evidence, physical device. |
| Real-product desktop performance (#570): idle, 2/5/10 voice, gaming + voice + screen share, 10k messages, 1080p60, 1440p/4K, soak, degradation | [#570](https://github.com/fatihcayiroglu/Bridge/issues/570) | Only synthetic A/B [#569](https://github.com/fatihcayiroglu/Bridge/pull/569), explicitly not product evidence | **NOT EXECUTED** | — | Needs Windows/macOS/Linux hardware with a game, GPU counters, independent clients and a real SFU path. |
| Voice/video/screen-share acceptance | #570 | Media Evidence scheduled success [40485237274](https://github.com/fatihcayiroglu/Bridge/actions/runs/40485237274) (what it covers was not re-read today) | PARTIAL | B | Real devices, real capture. |

## 5. Owner decisions, in one place
1. **#336** retention days (rec. 30 after resolve), open-report vs erasure (rec. keep until resolved, then scrub), legal hold, hard-delete cascade, flag in production.
2. **#537** callback domain, Android release certificate SHA-256, Apple Team ID.
3. **#533** fresh install starts signed out (PR implements yes).
4. **#530** findings 2 (unused scheme), 3 (step-up for native authorization), 4 (device-bound refresh).
5. **#536** vendored `deepmerge` (low severity; the gate does not fail on it).
6. **#205** is the supported metadata-only portability subset enough for P7?
7. **Android case 3 / web change** (this session): approve the "Use a different account" consent button on `/native-auth` (#548).

## 6. What would make P7 closable
Green exact-head Quality Gate on `main` (needs #574 merged); iOS cases 2 and 3 genuinely passing; API 37 executed or the owner accepting NOT EXECUTED; physical-device evidence or an explicit decision that it is a release gate rather than a P7 gate; D2 built beyond the inert foundation; B5 decisions plus CI; real-product desktop performance on actual hardware; #416 root-caused.
