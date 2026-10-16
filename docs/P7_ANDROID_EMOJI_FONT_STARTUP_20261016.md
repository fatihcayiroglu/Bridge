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
