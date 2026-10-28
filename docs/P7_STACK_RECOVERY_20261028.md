# Recovered P7 review stack (2026-10-28)

All entries below were read from GitHub metadata and exact-head CI, rather than
assuming the handoff's hashes/status. Existing local worktrees were clean and
preserved; remote Claude/Codex branches were fetched without rewriting history.
All listed work remains unmerged. P7 is OPEN; no deploy or production merge.

| PR | Exact head | Actual base / dependency |
|---|---|---|
|518|`e7de5d5c957d6d36691de1b501825df6e17599a2`|main; native-auth server, includes reviewed security ancestors|
|519|`15602ca76624bd5c89ff07c03fbdbd6463bf4923`|#374 security branch; qs patch|
|520|`bcaaf532b8167ff15518f43f25df81300fa07c96`|main; **Android209 CPU measurements**, not web handoff|
|544|`8f7b4125bb4cadbd46b8614be7cf7243e2422974`|#543 browser/session candidate|
|548|`d8ec3264a073ac8a2d4c70b8c5ebc586fbfab9c0`|#547 Android Custom Tabs; current product blocker|
|549|`1fffe8399aabe7efe22e566fec860dba74d24f75`|#546 version matrix; explicit unavailable-SDK gate|
|550|`48fd635beb39dcb9f66f072e695d4c4b3e9d2963`|#544; pinned iOS dependency acquisition|
|551|`086efade5f8011025a32990853f480c58b71a6c6`|#550; WDA diagnostics|
|552|`6ff65659a57f6137acf0f6d36dcc9d68bb8331ee`|#549; transient dump evidence and explicit gate preserved|
|553|`c4b7c3d1c103ffd1a76614631c3542744e483c99`|#551; field-integrity checks, fresh geometry/touch, WDA prebuild|
|554|`3c4b3a9856f90490e711e6aea7a09805326071fe`|#553 branch; signed-out RN layout smoke, older parent snapshot|
|555|`06679cc6b0f5af73d16ecdeccc29700711d6b01c`|#554; web viewport matrix, older parent snapshot|
|556|`ee84b01714b6929e1e97416ae9dbe5dc560162ab`|main; Electron initial work-area geometry|
|557|`e240888a24701355b8ace93cc65a2072ee7523bf`|main; Electron capture consent|
|558|`d99bc5811b82bfc211e1d60ae521cbd91d6d4dff`|main; targeted dependency remediation|

GitHub base branches can advance independently of the fork point. These are not
all incorporated into one tested candidate; preserve that distinction. No newer
related PR beyond558 was returned by the recovery search. Reviews were empty
for the inspected PRs; discussion checkpoints and first-failure records were read.

## Evidence checkpoint

- #548 run40714331771: verified2PASS/1FAIL/0NOT EXECUTED/0skipped cases; account
  switch offers A again. B/isolation/revocation substeps remain unexecuted.
- #553 run40717519808: dependency prefetch, app build, simulator boot/CA install
  and **separate WDA prebuild PASS**. Actual browser journey RUNNING. The configured
  `usePrebuiltWDA`/derivedDataPath are present in source; runner use and field-focus
  correction still need the actual journey/diagnostics, not a build-only claim.
- #552 run40693009607: required SDK-check step executed; emulator not started;
  named API37 NOT EXECUTED gate failed. Preserve red infrastructure/unavailable
  classification, never productFAIL or substitute API.
- #555 exact-head run40711404967:24 web viewport cases PASS,8 per browser engine,
  zero skipped/retries. This is browser CSS/layout, not native Electron monitors.
- #556 run40714405853: Windows/Linux native window/package gates PASS; macOS
  QUEUED. Quality Gate40714405864 FAIL at root security audit; downstream jobs
  did not run. Initial geometry does not prove DPI/hotplug transitions.
- #557 run40715961705: Windows, Linux **and macOS** native/package gates now PASS;
  the earlier discussion's macOS-queued statement is historical. No actual OS
  capture/TCC/portal/audio/monitor-disconnection acceptance is implied. Quality
  Gate40715961668 remains red at existing dependency audit.
- #558 run40718512366: all four security audit steps, type/build, minimum-Node
  compatibility and Windows startup behavior PASS. Full server unit/integration
  still RUNNING at this checkpoint. Native/mobile and other evidence jobs have
  separate pending status; low/moderate advisories remain open.

Native account switching needs the product decision in
[the proposed design](P7_NATIVE_ACCOUNT_SWITCH_DECISION.md). Continue independent
iOS, display, security and transfer engineering while that decision is pending.
No old acceptance job is rerun to hide a failure; no unchanged historical result
is relabeled as current native parity.
