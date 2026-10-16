# P7 final closure ledger — live audit (2026-10-16)

**State: OPEN. Do not declare P7 complete or start P8.** This is a triage baseline, not evidence that unrun acceptance is green.

**Source of truth:** [P7_TRUST_SOCIAL_FOUNDATION.md](P7_TRUST_SOCIAL_FOUNDATION.md). Historical PR statuses embedded in that document (e.g. #129, #183) are not current GitHub state; audit the **merged** implementation at the relevant commit, rather than relying on its old snapshot.

**Baseline main:** `ba3f218f2b16497ced2163864992bdfe358d5e1e` (#307 merged). #291 and #300 are closed. #306 patched a vacuous `links` test to real `link_filter`. #307 delivers manager-authorized per-current-installation link exemptions; the PR's latest exact-head CI included successful Quality Gate, Android, iOS, desktop native, federation and self-host workflows. Do not mistake these for real-device certification.

## Evidence boundary and acceptance matrix

| Pillar | Item | Classification | Evidence / exact remaining gate |
|---|---|---|---|
| A | A1–A7: encrypted local store, offline outbox/history/search and sync | **PASS (foundation); verify final lifecycle evidence** | #124 merged foundation; contract identifies exact-head A evidence `ac021863`. Before final closure, rerun relevant offline and account-isolation acceptance on final main. |
| B | B1: anti-raid, anti-spam and ingress parity | **PASS (recent ingress subpaths); full B1 audit pending** | #295–#303, #306–#307; #291 and #300 closed. Verify full B1 thresholds, rate controls and audit on final main. |
| B | B2: risk-adaptive security | **OPEN: evidence reconciliation** | Historical B2 material is extensive but contract's top-level status is stale. Enumerate acceptance B2 subitems and link each to current runnable evidence; do not treat the phase as unimplemented purely because documentation lags. |
| B | B3: metadata minimization | **OPEN** | Image metadata class has documented tests `server/tests/image-metadata.test.ts`, `e2e/tests/image-metadata.spec.ts`. Missing comprehensive class-by-class accounting of IP/device/session records, logs, telemetry, timestamps, access, retention, deletion/export and less identifying alternatives. |
| B | B4: E2EE research/hardening | **OPEN** | Inspect existing [P7_LOCAL_DATA_THREAT_MODEL.md](P7_LOCAL_DATA_THREAT_MODEL.md); establish channel/DM threat model, key lifecycle/multi-device, offline cache, backup/recovery, revocation/rotation, metadata and moderation boundaries. Separate **proven implementation** from research or unverified claims. |
| B | B5: moderation tools | **OPEN: acceptance evidence reconciliation** | Verify reporting, raid action, lockdown visibility, audit, expiration/reversal, permissions and multi-instance behavior as enumerated in P7 contract. AutoMod integration completion alone does not close entire B5. |
| C | C1: identity export | **PASS (bounded profile subset)** | Versioned profile export, integrity checksum, sensitive export step-up, #181 profile-only guarded apply. Preserve excluded secrets; checksum is not signature. Verify current UI and account-boundary acceptance. |
| C | C2–C3: community export and import | **PASS for explicitly supported existing-row metadata-only subset; unrestricted portability OUT OF SCOPE pending product decision** | #233–#243 merged. In controlled CA-valid two-installation TLS lab, signed source review and restricted owner-approved one-use mapped apply are evidenced. No implicit users/memberships/history/files/E2EE keys/role-channel entity creation or full grant transfer. See #205 and `docs/P7_LIVE_TLS_ROUND_TRIP.md`. |
| C | C4: anti-lock-in cross-installation restore | **OPEN: release/product acceptance #205** | Lab round-trip for supported subset has evidence, but independent production DNS/operator authenticity, approvals/recovery and scope decision remain. Keep #205 open until acceptance is explicit. |
| D | D1: PostgreSQL partitioning decision | **OPEN** | First measure row counts, hot queries, index sizes, access/write patterns and retention. A documented evidence-based **no-partition decision** is acceptable if performance supports it; do not partition speculatively. If partitioning is needed, document key, pruning, uniqueness/FK implications, compatibility, rollout, rollback and lock impact. |
| D | D2: ephemeral channels | **OPEN** | No accepted proof yet for server-authoritative expiry, idempotent cleanup, client tombstones, attachment/search/vector cleanup, audit separation, federation, clock-skew non-resurrection and user-visible expiry policy. Must implement and test if required by P7. |
| D | D3: migration safety | **OPEN: evidence reconciliation** | Per-migration forward path, compatibility, rollback/roll-forward, lock/runtime evidence, preflight and backup-restore. Include real PostgreSQL checks. |

## Cross-pillar / release gates

- **OPEN:** final exact-head Quality Gate, server+client strict coverage and zero-skip enforcement, real PostgreSQL, browser, self-host and federation verification, plus post-merge main green. Attach workflow URL, commit SHA, status and skip classification to each result.
- **OPEN/EXTERNAL:** [Android issue #209](https://github.com/fatihcayiroglu/Bridge/issues/209). Emulator L01 and ANR01 green runs do not establish root cause or physical-device certification. PR #304 collects failure-only CPU evidence; the probe was *not executed* in a passing ANR01 run. #238 remains diagnostic; preserve redacted causal evidence and device gate.
- **EXTERNAL/UNVERIFIED:** iOS physical-device/store signing and real production operator deployment. A green `Mobile iOS` workflow does not in itself establish those external conditions.
- **OPEN:** explicit #205 product acceptance: whether the supported metadata-only portability subset suffices for P7, or whether broader migration is mandatory. Do not silently downgrade the contract.

## Shortest honest route to closure

1. Freeze P7 scope and record acceptance ownership. Reconcile historical contract statuses with main before duplicating work.
2. Audit B2/B3/B4/B5/D1/D3 one criterion at a time; attach executable tests and **measured** evidence, not prose-only PASS.
3. Implement D2 end-to-end as a scoped feature if nothing verified already implements it.
4. Settle #205 subset acceptance decision explicitly; don't overclaim transfer coverage.
5. Keep #209 open until causal/device evidence; separately state whether real-device certification is a P7 gate or a release gate. A classification choice does not convert a failing test into PASS.
6. Complete final closure PR with accurate run IDs, test counts, failed/skipped results and post-merge proof. Only then mark P7 CLOSED.

### Integrity rules

Do not lower coverage gates; convert failures to skips; hide failed prior runs; label unexecuted tests PASS; or manipulate a historical acceptance ledger into a green result. In particular, audit and E2EE system messages have distinct principal classes and must not be misrepresented as plaintext moderation bypasses. Other agents' uncommitted `scripts/abuse-lab/run.mjs` is out of scope.
