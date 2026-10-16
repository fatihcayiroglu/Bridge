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
