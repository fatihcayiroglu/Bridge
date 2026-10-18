# Android #209 — remove optional emoji2 startup font provider (candidate)

**Status: CODE FIX CANDIDATE / NOT A ROOT-CAUSE CLOSURE.**

## Observed failure and mechanism

- [Android #209](https://github.com/fatihcayiroglu/Bridge/issues/209) records a prior Android 14 emulator ANR (5-second focus-input dispatch timeout, cold process replacement), and later process loss in repeated startup stress. Its earlier evidence included an Android app dependency on Google Play Services' `FontsProvider`. These observations alone cannot prove which app startup task caused the ANR.
- The source is a Capacitor WebView-first app. `MainActivity.java` extends `BridgeActivity`, only registering the native push-support plugin; no native emoji-enabled text editor is part of this Activity.
- AndroidX [Emoji2 documentation](https://developer.android.com/jetpack/androidx/releases/emoji2) explains that the transitive `EmojiCompatInitializer` can load a downloadable emoji font via a provider like Google Play Services shortly after first Activity resume. This task is useful for native AppCompat TextViews but not the Bridge WebView UI.

## Candidate mitigation

- Add AndroidX's documented `tools:node="remove"` manifest merger override for **only** `androidx.emoji2.text.EmojiCompatInitializer` in the curated **main** manifest. Keep the parent `androidx.startup.InitializationProvider` and all other initializers.
- This avoids a nonessential native font fetch on *release and debug* startup. WebView emoji rendering is not disabled; Android's system emoji font remains. The trade-off is that optional native AppCompat text widgets would not receive downloadable emoji2 glyph updates unless EmojiCompat is later initialized explicitly.
- Assert source manifest intent in mobile Jest; assert the **Gradle merged debug manifest** truly lacks the initializer in the Android CI build. Both checks are required, since an unapplied manifest overlay would give false confidence.
- Keep all existing Android emulator journeys, especially L01, L02, L03, P03 and ANR01. **No skips, no retries, no looser budgets or green assertions** added.

## Acceptance and unresolved work

The candidate is meaningful only if exact-head build/Android emulator and broader gates pass. Repeat cold-start stress on real and emulated devices, inspect process-exit and ANR data, and establish causal evidence before closing #209. In particular, an unchanged first-run pass does not demonstrate the historical non-deterministic crash is gone. See the separate #238 stress diagnostic effort and the merged #314 attach-socket instrumentation.

## FD01 — running-app provider dependency assertion

In addition to manifest tests, the Android emulator journey now runs **FD01** after the app signs in. It queries Android's `dumpsys activity processes` for the Bridge process and checks that **there is no live dependency on `com.google.android.gms/.fonts.provider.FontsProvider`**. The parser reports only a boolean and bounded counts; raw process data remains private. Unparseable provider connection records make FD01 **FAIL**, not a green assertion based on absent evidence.

This is a focused regression for the observed provider dependency in the previous five-start [#238 run 38722179952](https://github.com/fatihcayiroglu/Bridge/actions/runs/38722179952). A passing FD01 does **not** prove all Android ANRs are fixed; repeated cold starts and real hardware remain separate acceptance gates.

## Post-merge first-red and follow-up attribution (17 Oct 2026)

The **first post-merge main run** [38963835769](https://github.com/fatihcayiroglu/Bridge/actions/runs/38963835769) on `6adb3435b5eedb6c6ffbf4531c764a47d012c4f7` is **FAIL**: FD01 observed a live `FontsProvider` connection, even though the compiled APK's merged-manifest assertion for disabling the optional EmojiCompat initializer **PASS**. Android journeys: **32 PASS / 1 FAIL / 0 skipped / 4 measured**. L01 (HOT/stable PID), P03 (outbound RTP) and ANR01 (zero OS ANRs) passed in this red run. The exact PR head's FD01 PASS is not a substitute for the first-red main failure.

**Attribution is unresolved.** The documented AndroidX manifest entry suppresses *that startup initializer only*; it does not guarantee other components, including the embedded WebView, will never contact Play Services' FontsProvider. A provider connection's *presence* does not identify its caller or prove that a process was killed. #209 remains open.

This follow-up records privacy-safe, allowlisted provider stages just after the first UI and after login, with stable/unstable Android content-provider reference counts. A **stable** connection has different process-dependency implications from a transient unstable reference. No raw dumpsys output, PIDs, logcat bodies or user data leave the probe. Failed OS probe/ref parsing remains explicit; **FD01 still FAILS** for any observed connection and no normal test is skipped or relaxed. Once evidence identifies the actual ref strength and stage, only a causally supported change to product or gate is acceptable. Repeated cold-start and physical-device tests are still outstanding.

## Runtime EmojiCompat attribution (17 October 2026)

Post-merge #318 Android run [38969845837](https://github.com/fatihcayiroglu/Bridge/actions/runs/38969845837) is **FAIL**: the actual app holds **one stable, zero unstable** GMS FontsProvider reference both after first render and after login. Android emulator reports **32 PASS / 1 FAIL / 0 skipped**, including L01 HOT, L02 and ANR01 PASS. There is still no proof that this connection originated from AndroidX EmojiCompat, merely that it is observable early in the lifecycle. A stable provider reference is a real dependency and must not be waived as a harmless transient.

Follow-up instrumentation logs **only** `EmojiCompat.isConfigured()` at MainActivity pre-super, post-super and onResume, exclusively when Android marks the APK debuggable. This AndroidX API is read-only and does not initialize fonts. The test harness queries only the current process via `logcat --pid`, then reduces the results to allowlisted booleans (or explicit unknown), never exporting full logcat/PIDs. `FD01` remains FAIL if the provider connection persists, regardless of this diagnostic. If EmojiCompat is unconfigured but the provider still connects, the specific Emoji2 startup hypothesis is disproven and investigation must move to the actual caller (e.g. WebView or other native font consumption) before any contract changes.

## Exact-head regression and compilation correction (17 October 2026)

The [#318 Android run 38972177824](https://github.com/fatihcayiroglu/Bridge/actions/runs/38972177824) **FAILed at APK Java compilation**, *before* emulator journeys: `MainActivity.java:61 error: package androidx.emoji2.text does not exist`. The direct `EmojiCompat.isConfigured()` debug probe accidentally introduced a compile-time dependency not on this app's classpath. **This is a separate failure from the earlier FD01 red**, and no new Android emulator PASS/FAIL can be inferred from it.

Correction: debug-only `Class.forName("androidx.emoji2.text.EmojiCompat", false, getClassLoader())` observes **class presence only**, not `isConfigured()` or the provider caller. The API is never invoked, no EmojiCompat dependency is added, and neither release nor debug loads fonts through the probe. The fail-closed FD01 provider-connection test remains unchanged, preserving the unresolved one-stable-ref observation. If the class is absent at runtime, the AndroidX EmojiCompat origin hypothesis is further weakened; it still cannot identify the actual caller. Probe outputs are allowlisted booleans and user-data-free. No earlier failure is reclassified as green.

## Root-cause attribution improvement — 17 October 2026

Android run [38972932023](https://github.com/fatihcayiroglu/Bridge/actions/runs/38972932023) on `8d68b7a` proves **APK build PASS**, and exposes the same live **one stable GMS FontsProvider** link at both UI/pre-login and after-login. It has **32 PASS, 1 FD01 FAIL, 0 skipped**. The previous debug probe confirmed the EmojiCompat **class is present at runtime** (all three stage markers), even though its type is unavailable on the compile classpath. Class presence cannot establish initialization or explain who requested the provider.

New debug-only probe invokes the **public read-only `EmojiCompat.isConfigured()` API reflectively** at before-super, after-super and onResume. This avoids a direct compile-time dependency and exposes tri-state `true/false/unknown` with bounded, privacy-safe parsed log evidence. Reflection can cause standard Java class initialization, but the invoked API itself does not call EmojiCompat.init() or load a font; a class or diagnostic failure is explicitly unknown. It still does **not** identify the FontsProvider caller, and the strict FD01 gate remains red if the provider connection persists. If configured is true, determine which component calls `init` despite the merged-manifest exclusion. If configured is false throughout, focus on independent ContentResolver font consumers. Keep #209 open; do not retroactively reclassify prior failures as green.

## PID-verified diagnostic fallback — follow-up, not root-cause closure

The latest #318 Android run at `775a051d` had **32 PASS, one FD01 FAIL, zero skips**. The Android process still held **one stable** GMS FontsProvider reference at first UI and after login. The new native `isConfigured()` probe produced **no readable markers** on that run; `available: false` does **not** mean `configured: false`.

The follow-up test harness first reads PID-scoped logcat, then, only when no valid marker was recovered, reads the unique debug-only `BridgeEmojiStartupProbe` tag. The fallback accepts records only with the current app's **exact** PID in recognized Android logcat formats. No raw logcat/PIDs or user text appear in evidence. A regression test rejects markers from other PIDs, PID-less free text and invalid PIDs. Diagnostic availability is reported independently as `pid-filtered`, `tag-filtered-pid-verified` or `unavailable`.

This is an attribution/data-quality improvement only. **FD01 must remain FAIL** whenever a live provider connection is observed, including if native diagnostic markers cannot be obtained. The provider's initiating caller is still unidentified; #209 and physical-device acceptance stay open. Exact-head Android/Quality Gate CI is pending and must be reviewed before merging this draft.


## Controlled native-only versus plain-WebView differential (17 October 2026)

**Exact head:** `adbe1cdf005572d3b169461011139da5b99d6ad9`, [PR #322 Android run 39017377880](https://github.com/fatihcayiroglu/Bridge/actions/runs/39017377880). The debug APK built; the emulator journey **FAILED: 31 PASS, 2 FAIL (L01, ANR01), 0 skipped, 6 measured**. [Quality Gate 39017377863](https://github.com/fatihcayiroglu/Bridge/actions/runs/39017377863) and [iOS 39017377930](https://github.com/fatihcayiroglu/Bridge/actions/runs/39017377930) succeeded on that same head; the nightly-only full/media job is not counted as a pass on this PR.

The same installed Android 14 emulator APK was force-stopped between each controlled Activity:

| Stage | Real `dumpsys activity processes` result | Conclusions |
| --- | --- | --- |
| FD00 plain Android `Activity`, no WebView | Verified provider listing, **no** Google FontsProvider reference | Negative baseline for **this** native-only Activity and emulator run |
| FD00W Android `Activity` + only `android.webkit.WebView` displaying `about:blank` (JS disabled) | Verified provider listing, **one stable** Google FontsProvider ref | An ordinary WebView can initiate the provider connection **without** Bridge's JS app or Capacitor |
| Bridge `MainActivity`, first product UI | **one unstable** FontsProvider ref | Caller still not identified at the method/process level |
| Bridge `MainActivity`, after login | **no** FontsProvider ref in this sample | Strict FD01 passed **in this run only**, but has repeatedly failed on other exact heads |

The Google Play services **font** content provider and the Android **WebView implementation/provider package** are separate concepts. The observed call-chain differential does **not** prove the exact font requester within WebView nor that the provider is removable from Bridge without breaking the WebView product. Do not block/kill Google Play services or revoke provider access speculatively. Android's downloadable-font contract describes legitimate app-to-provider queries; that is **not** evidence that a font query caused an ANR.

### More important: L01/ANR01 real user-facing regression reappeared

In the **same red job**, when L01 backgrounded the product Activity for 20 seconds, the original Bridge PID disappeared and `am start -W` reported **COLD**. Targeted `ApplicationExitInfo` identified **reason 6 (ANR)** on the previous PID (record time **08:33:26 UTC**). At ANR01 the independent ActivityManager category parser recovered **`input_dispatch_timeout` with `focusEvent=true`**, matching the historical symptom. Therefore **L01 FAIL** and **ANR01 FAIL** are real, must not be relabelled as startup recovery passes, and outweigh a transiently green FD01.

The red job's bounded ANR CPU evidence captured a **post-event** sample with load `[26.52, 7.26, 2.47]`, total CPU **100%**, app **37%**, `system_server` **57%**, WebView renderer **0% in that interval**. These values do not establish a causal blocked call or thread stack. Earlier runs, notably `39015735748`, proved intermittent stable/unstable font references **without** an observed ANR. Correlation cannot be upgraded to causation.

**Release gate remains OPEN:** retain strict L01/ANR01/FD01 results unchanged; compare a sufficiently repeated normal production-path startup against FD00/FD00W instrumentation and real physical Android hardware, gather bounded main-thread/platform ANR attribution, and separately revisit whether a zero-FontsProvider requirement is under Bridge's control for a WebView-based app. Changing FD01 solely to make CI green is prohibited. Prevent future raw device log exports (PR #323) without erasing historical red evidence.



## 17 October 2026 — controlled WebView localization and negative observer-ablation result

Two independently executed Android 14 emulator comparisons, [baseline #322](https://github.com/fatihcayiroglu/Bridge/actions/runs/39061720181) and [observer-ablation #327](https://github.com/fatihcayiroglu/Bridge/actions/runs/39061117747), both reported **33 PASS, 1 FAIL (FD01), 0 SKIPPED, 12 MEASURED**. L01 HOT with PID retained, CS01 and CS00 controls completed, ANR01 reported 0 system ANRs **in these runs**. Neither eliminates the historical FocusEvent ANR/process death.

The following separately force-stopped activities had verified Android provider listings:
- Native-only Activity **FD00**, AppCompat-only **FD00P**, constructed but unattached/unnavigated WebView **FD00C**, and attached but unnavigated WebView **FD00A**: **zero** FontsProvider connections in both runs.
- A plain WebView navigating to `about:blank` **without attachment** (FD00N) and a plain attached WebView navigating to `about:blank` (FD00W): **one stable** FontsProvider connection, even though there were **no Bridge web assets, Capacitor plugins or JavaScript**. The FD00W same-process connection remained present at 1.5, 4 and 8 seconds.
- Real Bridge FD01: provider reference was still present at its after-login checkpoint, **strict FAIL**. Its later same-PID FD02 observations showed reference disappearance; this does not retroactively make FD01 pass.

A separate experiment removed the debug instrumentation's reflective static call to `EmojiCompat.isConfigured()`, replacing it with **noninitializing class-presence-only** `Class.forName(..., false, loader)`; it now truthfully logs `configured=unknown`. FD01 still FAILED. This is a **negative** A/B result: reflective static invocation is not required for the observed WebView font connection. To prevent future observer interference, the noninitializing diagnostic and its Jest contract are retained on #322; the separate #327 experiment can be closed without merge. This change is debug-only; it does **not** remove, block, kill, or mock system FontsProvider.

**Inference boundary:** The evidence localizes creation to the WebView **navigation** path on this tested emulator, not to the precise requester inside Chromium/Android. It does not establish that FontsProvider causes the observed process death, nor that a platform-owned WebView implementation can fulfill a zero-connection contract without functional regression. Preserve strict FD01 and historical red run evidence while separately proving safety during provider loss, Android process resurrection and real-device acceptance. #209 remains OPEN.

 
## 17 October — FD00D interpretation correction and FD00T teardown experiment

The exact-head run [39065266704](https://github.com/fatihcayiroglu/Bridge/actions/runs/39065266704) had **33 PASS, 1 FAIL FD01, 0 SKIPPED, 13 MEASURED**. A01, CS00, CS01, L01 and ANR01 passed **in that one run**; strict FD01 remained red. FD00D navigation with inert inline HTML, no network resources and JavaScript disabled still acquired one stable FontsProvider reference, just as FD00N/FD00W did.

**Precision:** Android's [`WebView.loadDataWithBaseURL` documentation](https://developer.android.com/reference/android/webkit/WebView#loadDataWithBaseURL(java.lang.String,java.lang.String,java.lang.String,java.lang.String,java.lang.String)) says a **null `baseUrl` defaults to `about:blank`**. FD00D therefore isolates Bridge's HTML/JavaScript and ordinary network resources, but does **not** eliminate an `about:blank`-origin explanation. The supported inference remains: on this emulator, navigation to a minimal document can acquire FontsProvider even without Bridge/Capacitor code. A distinct `data:`-scheme control would be needed to rule out the origin-specific possibility. Do not reinterpret FD00D as such a control.

To separate provider ownership by a live WebView object from wider WebView process/runtime ownership, an additional DEBUG-ONLY `FD00T` measurement creates a navigated inert WebView, then explicitly `stopLoading()`, detaches, `clearHistory()`, `destroy()` and dereferences it on the main thread while keeping the Activity foreground and its original PID intact. Two verified ActivityManager provider snapshots and a same-PID teardown marker distinguish actual reference release from process death, unverified measurement or mere elapsed time. This is **MEASURED only**; FD01, L01 and ANR01 gates remain STRICT. Android's [WebView memory management guidance](https://developer.android.com/develop/ui/views/layout/webapps/manage-webview-memory) motivates the complete teardown sequence. Whether refs disappear after teardown is **unknown until exact-head emulator CI**. The historical FocusEvent ANR, dependency-death pathway and physical-device acceptance remain open in #209.


## 17 October — FD00T shows process-wide font-provider retention; A01 dependency death

The exact-head [Android CI run 39067739321](https://github.com/fatihcayiroglu/Bridge/actions/runs/39067739321) on `0da0029c` was **33 PASS / 1 FAIL (A01) / 0 SKIPPED / 14 MEASURED**. The FD01 check happened to pass on a later restarted product process, as did L01 and ANR01; **this is NOT platform resolution**.

The new, verified `FD00T` same-process control measured exactly **one STABLE FontsProvider reference before and after** a `WebView` was stopped, detached, history-cleared, destroyed and dereferenced, while the same Activity remained foreground and the original app PID remained alive. The fixed PID-filtered teardown marker was present. This supports **reference lifetime beyond the destroyed WebView instance** under this emulator's Java/Chromium/Android runtime; it does not prove which process owns the reference or whether it ever releases it without process death.

More significantly, A01 originally launched with `Status: ok`, `LaunchState: COLD`, a live initial PID and a Playwright page. Before A01 completion, the page became closed and the app process disappeared. Android's same-PID `ApplicationExitInfo` recorded **reason code 12 (DEPENDENCY DIED), subreason 0**. No A01 ANR can be claimed from this record. The specific upstream provider/process **was not identified in that run**; inferring it was GMS FontsProvider from other runs would overstate the evidence.

New #322 instrumentation classifies any separately available, exact-PID ActivityManager `Killing ... depends on provider ... in dying proc ...` evidence into only **`gms-fonts`, `other-provider` or `unknown`**, and reports `gms-persistent`, `other-process` or `unknown` for the upstream process. Missing or malformed evidence remains UNKNOWN; no raw PIDs, provider identifiers, stack data, names or user content appear in exported reports. Additional direct unit tests reject unsafe PID selectors and spoofed unrelated OS exits. This is diagnostic only, not a retry, mitigation, or gate relaxation.

`L03` already enforces session/channel/missed-message restoration after background OS process death; it does not prove resilience against dependency death **mid-startup**, which remains the focus. Keep strict FD01, A01, L01 and ANR01 unchanged and #209 open pending upstream kill-line attribution and physical-device acceptance.

## 18 October — distinct data:-scheme document navigation control (FD00S)

The previous `FD00D` control calls `WebView.loadDataWithBaseURL(null,...)`, for which Android documents the fallback base URL as `about:blank`. Therefore FD00D's connected FontsProvider result cannot distinguish **generic document navigation** from an **about:blank-specific** trigger. The new DEBUG-only `FD00S` comparison uses `WebView.loadData(base64Html, "text/html", "base64")`, which Android documents as a `data:`-scheme URL. HTML is local and contains no external resources, scripts, Bridge assets or Capacitor plugins; JavaScript is off. The Activity's process is freshly cold-started, the provider listing must be complete or the measurement is marked FAIL, and the app is force-stopped before subsequent controls. This test is measurement-only; strict FD01, A01, L01 and ANR01 remain untouched.

**Interpretation pre-registered before CI:** FD00S linked + FD00D linked => the dependency is **not restricted to about:blank** on that Android WebView/image. FD00S verified zero + FD00D linked => the trigger differs by navigation path, but exact Chromium/OS requester remains unidentified. FD00S probe incomplete => no inference. Regardless of the result, no inference establishes the cause of the historical DEPENDENCY DIED or FocusEvent ANR; keep #209 OPEN. Android API docs: https://developer.android.com/reference/android/webkit/WebView
