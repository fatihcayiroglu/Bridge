# Shared message viewport observers — candidate, not measured speedup

Base #584 verified04e54d5d26ce5281248f601f1cdc0a664c1f0783; original successful and failed histories retained. P7 OPEN, no main merge/deployment.

## Actual motivating evidence

Run40845246463/job123351018844 passed real packaged PA01300.109s and PA08120.401s/full10000 IDs/200HTTP200, both endpoints and adjacent keyboard, sampled heavy-row peak200. However PA08 API CPUmean28.344%, sum working sets mean1358.29MiB/peak1565.09MiB (shared pages can double-count), rAF intervalp95100ms and final66071 event listeners remain substantial. This qualifies execution, not smoothness or low-resource targets. Artifact12884544199 SHA256e5e82ea670c5b938383dcc1cb7f1794812b742f7d5759f7a0c19080e02c4aedb verified.

The row implementation installed one IntersectionObserver, one ResizeObserver and six interaction listeners per loaded anchor. With10000 anchors, those observer/listener owners scale with history even while heavy message components are bounded. Reducing these owners is a source-grounded experiment; their exact causal share of CPU is not established.

## Change and verification

Share one row-intersection/size observer pair and one capture listener set per actual scroll root. Route events by live wrapper node, without reading message text, credentials or account data. Unobserve each removed row; reject queued deliveries for removed nodes; release both observers/listeners when the last row goes away. Keep independent list resize/bottom-intent handling, same overscan/heights/model ownership/navigation/media retention and observer-unsupported fallback. No library/dependency or auth/storage/backend change.

Local266 component/consumer tests and12 executor contracts PASS, zero failed/skipped; strict client types/build PASS, Svelte0errors/warnings. New shared-resource/disposal test covers500 rows, actual delegated reveal, unobserve/disconnect and late-event rejection. Existing keyboard/account/height/media/menu/fallback and other list consumer tests retained. The first test run113PASS/1FAIL/0SKIP wrongly expected detached Svelte DOM to erase every child; corrected checks require the old root detached, no old article in the live host and unchanged detached markup after late events. Original failed JSON preserved in bridge-p7-row-pool-components-first-20261029.json; no product/native assertion weakened.

Real packaged candidate CI pending. Same10000 IDs/120s, endpoint/keyboard, mounted-heavy-row<=240 and security/authentication assertions remain. Actual CPU/working-set/rAF counters must be inspected before claiming a speedup; no old run is rerun for green. This does not solve growing model/anchor memory, browser-find/assistive reading parity, rich-media/native resize acceptance, physical compatibility, original Android/Wayland causality or unexecuted gaming/SFU scenarios.


First source47bccf17f87df9d04649d2c81249bde1d0babe5f run40847405751/job123358182688 FAILed at the expanded component step:238 tests PASS,0failed test assertions/0SKIP, but one suite failed collection (message-action-sheet:No such built-in module:node:), so the job correctly failed. Native build/measurement NOT EXECUTED. Artifact12886275621 SHA256dbffe92b1f9622d071fdfb223fff84aca1802a29c6fe324ff4223c009ed1b777 downloaded/verified.

Controlled local NODE_ENV=production reproduces collection failure/browser externalization of the suite's Node fs/path imports; normal/test environment runs those assertions. Fix only the jsdom/Vitest step to NODE_ENV=test. The actual production Svelte/backend/DEB build and HTTPS packaged runtime still inherit NODE_ENV=production. Do not remove suites/assertions, mark a collection failure green or change actual runtime authentication/TLS/timeouts. New head requires its first CI result.
