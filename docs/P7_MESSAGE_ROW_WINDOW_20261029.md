# P7 message row window — experimental native candidate

Base #583 exact64d95b21aa4b4fcba4b094d8da6d42ecb2f04302; original histories and failures preserved. No production merge/deployment. P7 OPEN.

## Actual evidence motivating this change

#583 first run40797988093/job123198998624 at fdc77bfcde3b76bcd2283228b418c34a42ec8524 failed HISTORY_TRAVERSAL_INCOMPLETE:6050 messages/121 actual HTTP200 history responses. Real content-visibility events skipped5964 rows, but renderer script duration84.898s versus layout2.886s;594346 nodes,785029392-byte JS heap at failure. Artifact12865346998 SHA256e9d096bc33107778f1ed2dc14b316eaddc0fefae301ec650a8d7548dbac76a5e.

Its successor64d95b21 first run40798963527/job123202187247 also failed HISTORY_TRAVERSAL_INCOMPLETE:6750 messages/135 HTTP200 responses,6664 rows skipped. Renderer script81.622s versus layout3.192s/style2.836s,645567 nodes,497409068-byte heap at failure. One real pointerdown/captured click/bubbled click/login request, HTTP200. This successful login does not fix or explain the independent intermittent no-response failures. Artifact12865272815 SHA25689c63f222c228acc7d75619c466391db1edc7979fc9b248a4b967c1df56e1319. Both runs completed actual300s PA01; their PA08 resource series remain failed-attempt diagnostics, not acceptance measurements.

These observations support reducing expensive mounted message components; CSS layout skipping alone did not meet the gate. They do not establish every script cost or a controlled speedup.

## Implementation

Histories above200 models retain one lightweight anchor per loaded message, but mount MessageRenderer only near the real scroll viewport (600px overscan), for the roving focus target, or while it owns focus/an open modal or menu/playing audio or video. Actual ResizeObserver row heights replace initial26/64px estimates. All models and stable message IDs remain in the existing AppState; no persistence/cache/account/auth changes. Missing observer prerequisites render all messages.

Home/End/adjacent keys, reply and unread jumps reveal the anchored component before focusing/highlighting it. Deferred navigation is scoped to the current account/channel generation; stale callbacks and destroyed observers cannot revive an old row. New-channel teardown disconnects observers. Existing optimistic sending/retry/reaction paths remain in the same model owner.

The native executor still requires10000 distinct actual server message IDs, first/last viewport visibility,120 seconds of history activity and adjacent keyboard navigation. It scrolls actual product anchors before querying virtualized endpoint articles and additionally requires mounted-message peak<=240. It never drops the10000/120s or security/auth assertions. ASAR alone identifies the Electron wrapper, so provenance now also hashes the actual HTTPS-served UI module; this is required to distinguish Svelte changes served by the backend.

## Verification and remaining acceptance

Local existing/new component regression:112 PASS/0FAIL/0SKIP. Seven added cases cover bounded large-history presentation with retained models, measured rich-row height, offscreen keyboard/reply access, stale observer/account callbacks, playing-media retention, open-menu retention and unsupported-observer fallback. Mock observers validate component behavior; they are not native layout/media decoding evidence. Executor integrity contracts12/12 PASS, zero skipped. Strict client TypeScript PASS; Svelte check0errors/0warnings; production UI build PASS.

Real packaged candidate CI pending, not PASS. Native first/last/keyboard/scroll anchoring, resize and rich-media behavior still need actual runtime evidence. Browser find-in-page and assistive reading cannot search unmounted message text; built-in application search and screen-reader parity must be assessed before release. Placeholder geometry is estimated until first measurement and may shift on resize. This is not full list virtualization: lightweight anchors and message models still grow with history. No bounded total-memory, startup-SLA, physical-device, Wayland or complete P7 claim.
