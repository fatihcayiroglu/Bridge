# EX01: isolate preference state across the Android stop interval

Third experiment [40312295839](https://github.com/fatihcayiroglu/Bridge/actions/runs/40312295839)
failed original EX01 channel restoration. Immediately pre-stop the preference
and active channel matched. The earliest instrumented boot had the key but a
different value; it stayed unchanged through failure. Native focus was
`bridge-main`, with one focus entry and zero observed ANRs/dialogs. Product
journeys were 36/0/0/7; CR00 passed. None of that cancels EX01 FAIL.

The pull-request workflow head was `71ecc252`; checkout/artifact commit was
`0ecb4fc5`. Both have tree `3f7d2ce77309d616098d472f3f9354d853537846`.
Artifact 12646246738 was source/digest verified (SHA-256
`5a115c1b5e6f13f60de1500d196cb36139fdf1637734ff0193f0288c6512dd58`).

This still does not distinguish a late app write between the pre-stop sample
and termination from persistence behavior across the stop. The independent
EX02 control runs only after that retained first EX01 storage mismatch:

1. Select the same authorized channel and verify the current preference/UI.
2. Attach a real Chromium DevTools session to that Android WebView. Register
   a test-only freeze-event promise, request `Page.setWebLifecycleState(frozen)`
   and require the renderer's actual `freeze` event through inspector evaluation.
3. Read the browser's `DOMStorage` area while app tasks are frozen. Require the
   exact preference still to match, or stop without launching.
4. Perform one original cold launch and read the existing pre-application boot
   probe. Record `retained`, `missing`, `different` or `unverified`.
5. Unfreeze/detach any surviving original page; cleanup failure stays explicit.

The original EX01 result, native focus assertion and process exit gate stay
unchanged. EX02 is a separate conditional measurement, never a retry or product
PASS. It cannot make the failed job green. Unrelated failures are explicitly
not applicable. No arbitrary sleep, increased original deadline, direct storage write,
policy change, browser/native production change or assertion bypass is added.
Existing 100-second abort-aware sequencing is reused, with bounded 5-second
cleanup. The renderer freeze-event wait is bounded at 4 seconds.

The control uses established test APIs:
[Page.setWebLifecycleState](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-setWebLifecycleState),
[DOMStorage.getDOMStorageItems](https://chromedevtools.github.io/devtools-protocol/tot/DOMStorage/#method-getDOMStorageItems).
It is restricted to the emulator's debug package. Raw protocol storage entries
stay in memory and are reduced to presence/equality booleans; malformed,
duplicate or oversized data stays unknown (512 entries / 262,144 characters).
No token, URL, private key/value, component name, PID or raw exception is logged.

Freeze/read commands change the experiment's timing and can influence pending
IO. Retention in this control is nonreproduction, not a fix. A mismatch with
verified freezing narrows the evidence to that controlled stop boundary; pending
pre-freeze operations or other native contexts are not proved absent. It does
not diagnose the historical FocusEvent ANR or replace physical-device evidence.

Also correct one verified diagnostic error: a preference absent at boot but
created later previously reported `changedSinceBoot=false`; its new regression
fails before the one-line correction. Existing cases remain intact. The temporary
stack-specific Android trigger is restored to normal main/develop triggers;
exact-head Android and full Quality Gate are dispatched explicitly.

Local injected-IO tests do not substitute for real emulator calibration. #476
remains diagnostic/draft; #209/#321 stay open and #375 is not merged.
