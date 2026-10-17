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

