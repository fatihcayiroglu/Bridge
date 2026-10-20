# Android #209 — controlled WebView comparison (one variable at a time)

**2026-10-20 · design and predictions recorded before the first run · AUTOMATED / EMULATOR only · #209 stays OPEN**

Tracking issue: [#209](https://github.com/fatihcayiroglu/Bridge/issues/209). Root cause and mitigation: [`P7_ANDROID_209_ROOT_CAUSE.md`](P7_ANDROID_209_ROOT_CAUSE.md).

## Question

Does the STABLE `com.google.android.gms.fonts` reference, and the DEPENDENCY DIED exposure it creates, follow the **WebView (Chromium) version** alone? The source analysis says yes: the leak is in Chromium's `AndroidFontLookupImpl` and is fixed from `117.0.5938.29` / `118.0.5971.0`. Earlier cross-image evidence (API 34 + WebView 113 against API 35 + WebView 124) changed the OS, Play services and WebView together, so it could not isolate the WebView.

## Arms

| Arm | OS image | Play services | WebView provider | Bridge APK | Where |
|---|---|---|---|---|---|
| A | API 34 Google APIs x86_64 (CI image) | image's own | image's own `com.google.android.webview` **113.0.5672.136** (unfixed) | same debug APK | `controls` job, `system` |
| B | same | same | **Chromium SystemWebView 158.0.8114.0** (`com.android.webview`), selected with `cmd webviewupdate set-webview-implementation` | same | `controls` job, `chromium-fixed`; `product-fixed-webview` job |
| C | API 35 Google APIs x86_64 | image's own | image's own WebView 124.0.6367.219 (fixed) | — | historical only ([#329](https://github.com/fatihcayiroglu/Bridge/pull/329), run 39117109756); changes three variables, not re-run here |

Only the WebView provider differs between A and B. The OS image, Play services, emulator options (`-gpu swiftshader_indirect`, pixel_6, 2 vCPUs) and the APK are the same.

**The fixed WebView build.** It is the official Chromium continuous build `AndroidDesktop_x64` r1722592 from the `chromium-browser-snapshots` bucket. Its `SystemWebView.apk` declares minSdk 29, targetSdk 36, ABIs x86/x86_64. Two values are pinned in the workflow, the archive SHA-256 (`97bb6b0d…228a`) and the APK SHA-256 (`28d6eaf5…6369`), so a different file fails the job before anything is installed. Chromium `main` keeps `AndroidDownloadableFontsMatching` enabled by default and still prefetches through `FetchAllFontFiles`, so build 158 takes the same font path as 113, with the dup-and-close fix.

## Predictions (falsifiable)

| Observation | Arm A (113) | Arm B (158), if the WebView alone decides |
|---|---|---|
| FD00N / FD00D / FD00S (navigated controls) | 1 STABLE | **0 stable** (at most a transient unstable reference in the 1 s retain window) |
| FD00W (idle plain WebView, 1.5 / 4 / 8 s) | 1 STABLE throughout | **0 stable** at every sample |
| FD00T (after `WebView.destroy()`) | 1 STABLE survives | **0** |
| FD00G (forced finalization) | stable 1 → 0 | nothing to release: 0 → 0 |
| FD00 / FD00P / FD00C / FD00A (no navigation) | 0 | 0 |
| Product: release-pass marker | `pass-complete` ×2 | **`stage=skipped reason=webview-not-affected`** |
| Product: FD01 after login | PASS only with the mitigation | **PASS without it** (the gate skips) |
| Product: PD01 | PASS | PASS |

**What refutes the claim:** any STABLE FontsProvider reference in a navigated arm-B control or in arm-B FD01. **What does not count as support:** zero references in arm B together with no sign that the prefetch ran at all (no transient unstable reference anywhere). That result would be reported as inconclusive, not as confirmation.

## Confounds that remain

- **Chromium is not Google's WebView build:** branding, field-trial configuration, compiler optimisation and size (418 MB, unstripped) differ. A difference only in timing or ANRs could come from the build, not from the font fix.
- **Provider selection:** a debuggable image skips the signature check, but `com.android.webview` must be in the image's configured provider list. If the image refuses it, the arm-B jobs FAIL with `WEBVIEW_OVERRIDE status=refused reason=…` and the list of configured provider package names. That is a recorded blocker, never a pass.
- **One run is one sample.** Repeat before drawing conclusions about intermittent behaviour (FD01 intermittency, DEPENDENCY DIED timing, ANRs).

## Not covered

- **Physical devices:** none available. No device result exists or is implied.
- **A Google-built fixed WebView on API 34:** not obtainable here. Google's WebView is distributed only through Play.
- **Arm C:** it is not re-run here, because it changes the OS, Play services and WebView together.

## Results

Filled in from exact-head CI logs only.

| Run | Head | Arm | Result |
|---|---|---|---|
| — | — | — | pending |
