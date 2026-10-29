# Bounded older history pages — existing server contract, unchanged quota

Base integrated#587f7d548384406ee90b4dbc6b8f77d2dc8a81243b0; all original histories preserved. P7 OPEN, no main merge/deploy.

## Actual failure

Shared observer source#586662dfb200745d69bb1dee663198c44a00daff4e7 first40847905246/job123359829940 passed266 component+12 executor tests, actual production build and secure HTTPS UI authentication, then failedPA08/HISTORY_HTTP_STATUS. Exactly199 history HTTP200 responses/9950 IDs and oneHTTP429; no network/runtime errors. NativePA01 completed; PA08 unqualified. Artifact12886611080 SHA2564c2ed0b7005d06519b1e1b2c9668d50f6d0ce8ea031a706101b89063a1980035 downloaded/verified. Final event-listener count5919 is a failed-attempt observation, not a qualified performance speedup.

The client used50 rows for every history request. Reaching10000 required200 history responses plus initial account/channel traffic within the unchanged API request budget. The real server already validates limit1..100 (routes/messages.ts) and rejects values above100; no rate-limit increase/exception is introduced.

## Change and checks

Keep initial page50 for first paint. Request older cursor pages at the existing bounded maximum100, halving subsequent pagination requests. Preserve server cursor/hasMore authority, all rows/IDs, account/channel stale-response checks, deleted-row filtering and encrypted cache ownership. No retry, quota bypass, auth/TLS change, server endpoint increase, shortened observation or weakened full10000/viewport/keyboard/CSS/window assertion.

Local loader/cache suites29/29 PASS,0FAIL/0SKIP, including a full100-row older response retained with current latest row and unchanged initial50 request. Full related component/consumer/loader group295/295 PASS, zero skipped; strict client types/build PASS, Svelte0errors/warnings. Same native production test and realPG16/Redis workflow must run on this new combined head. Current native/service results pending, not inherited from earlier parent-green runs.

The existing429 failure remains preserved and cannot be relabeled PASS. No claim of smoothness, bounded total memory, clean startup SLA, mobile/physical/minimum/API37/gaming/SFU/Wayland acceptance or complete D2 cleanup. Browser-find/assistive reading/rich media parity and owner lifecycle decisions remain release gates. OriginalB1 untouched.
