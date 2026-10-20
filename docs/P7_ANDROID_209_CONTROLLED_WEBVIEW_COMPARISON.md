# Android #209 — controlled WebView comparison (one variable at a time)

**2026-10-20 · predictions recorded before the first run; first run supports them (one run per arm) · AUTOMATED / EMULATOR only · #209 stays OPEN**

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

Filled in from exact-head CI logs only. First run: [39398677365](https://github.com/fatihcayiroglu/Bridge/actions/runs/39398677365), head `f1706a2`, `workflow_dispatch`, all three jobs on the same API 34 image.

**The provider switch worked.** The image's configured provider list contains `com.android.webview` (listed as not installed before the install, valid after it). The selection read back as `com.android.webview@158.0.8114.0`; the harness's device facts show `aosp-webview` 158.0.8114.0. Both pinned hashes verified.

| Observation | Arm A, WebView 113 (job 118548880771) | Arm B, WebView 158 (jobs 118548881167, 118548880764) | Prediction |
|---|---|---|---|
| FD00 / FD00P (no WebView) | 0 | 0 | held |
| FD00C / FD00A (WebView constructed or attached, not navigated) | 0 | **0 stable / 1 unstable** | not predicted (see below) |
| FD00N / FD00D / FD00S (navigated) | **1 STABLE** | 0 stable / 1 unstable | held |
| FD00W at 1.5 / 4 / 8 s | **1 STABLE** at every sample | 0/1 at 1.5 s, then 0/0 and 0/0 | held |
| FD00T after `WebView.destroy()` | **1 STABLE survives** | 0 | held |
| FD00G ×3 (forced finalization) | stable 1 → 0 on the same PID | 0 stable before; nothing to release | held |
| CS00 cold starts | 6/6 PID-stable, 0 ANRs | 6/6 PID-stable, 0 ANRs | — |
| Product: release-pass marker | (product job on `main`: `pass-complete` ×2) | **`stage=skipped reason=webview-not-affected`** at first UI and after login | held |
| Product: refs at first UI / after login | (`main`: 0/1 after pass 1; 0/0) | **0/0 and 0/0** without any pass | held |
| Product: totals | — | **35 PASS / 0 FAIL / 0 SKIPPED / 6 MEASURED**; FD01, PD01, ANR01 (0), CS01 (3/3 PID-stable), L01 (HOT) PASS | — |
| Controls totals | 0 / 0 / 0 / 13 MEASURED | 0 / 0 / 0 / 13 MEASURED | — |

**Reading.** On the same OS image, Play services and APK, the STABLE FontsProvider reference appears with WebView 113 and does not appear with WebView 158. The prefetch did run on 158: the transient unstable reference is the positive control. That fits the source analysis: the stable reference follows the WebView (Chromium) version. It is one run per arm and a Chromium build, not Google's (§ Confounds), so it is support, not proof for every Google WebView release.

**Unpredicted:** on 158 the font fetch already happens when a WebView is constructed, without a navigation (FD00C/FD00A show an unstable reference; 113 shows none). The fetch trigger moved earlier in newer Chromium. The reference is unstable only, so it carries no DEPENDENCY DIED risk.
