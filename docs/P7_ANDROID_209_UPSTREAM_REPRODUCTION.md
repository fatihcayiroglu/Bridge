# Android #209 — WebView / FontsProvider upstream reproduction dossier

**2026-10-18 · experimental evidence · not a proven root cause · do not merge as a product fix**

> **Update 2026-10-18:** the upstream question below is answered in source. The stable reference is a Chromium bug fixed in 117.0.5938.60: the ContentResolver font descriptor was detached without being closed, so its stable reference waited for GC finalization. See [`P7_ANDROID_209_ROOT_CAUSE.md`](P7_ANDROID_209_ROOT_CAUSE.md) for the source chain, the FD00G intervention control and the product mitigation.

Canonical diagnostic PR: [#322](https://github.com/fatihcayiroglu/Bridge/pull/322).
Tracking issue: [#209](https://github.com/fatihcayiroglu/Bridge/issues/209).
The independent Android-15 platform-image experiment [#329](https://github.com/fatihcayiroglu/Bridge/pull/329) is **closed without merge**.
The CI SDK-image installation fix [#328](https://github.com/fatihcayiroglu/Bridge/pull/328) has already been merged.

## Problem statement suitable for an upstream WebView / Android report

A bare `android.app.Activity` with an Android `WebView`, JavaScript **disabled**, and an inert, entirely local HTML document acquires a connection to Google Play Services' FontsProvider. On the observed **Android 14 / Google APIs x86_64 / Google WebView 113.0.5672.136** image, this is a **stable** ContentProvider reference. The stable reference remains after `WebView.stopLoading()`, removing the WebView from its parent, clearing history, `WebView.destroy()`, and dropping the Java field, while the Activity remains resumed and its process PID stays unchanged. The same minimal controls on an **Android 15 / Google APIs x86_64 / Google WebView 124.0.6367.219** image acquire an **unstable** reference, which is gone after the same teardown.

This is a *platform-image difference*, not an isolated WebView-version regression: the Android OS, Play Services and bundled WebView versions change together.

**Question for upstream maintainers:** Is the persistent **stable** FontsProvider connection in the Android-14/WebView-113 environment intentional? If not, which Android/Chromium change controls its acquisition, reference strength and release? Can that dependency survive until process exit even after the last navigated WebView is destroyed? An upstream explanation would help establish whether an application can mitigate a dependency-death risk without manipulating Google Play Services or overriding WebView internals.

## Minimal Android control (no product code)

Run in a DEBUG-only Activity with a standard Android app; this is already implemented as `WebViewDataSchemeBaselineActivity` / `WebViewTeardownBaselineActivity` in PR #322:

```java
WebView view = new WebView(this);
view.getSettings().setJavaScriptEnabled(false);
setContentView(view);
String html = "<!doctype html><html><head></head><body></body></html>";
String data = Base64.encodeToString(
    html.getBytes(StandardCharsets.US_ASCII), Base64.NO_WRAP);
view.loadData(data, "text/html", "base64"); // data: URL, no remote resource

// For a separate teardown test, after navigation:
view.stopLoading();
((ViewGroup) view.getParent()).removeView(view);
view.clearHistory();
view.destroy();
view = null;  // keep the Activity/process foreground throughout
```

Reproduce on each chosen system image, with independent cold app processes:

1. Cold-start a **native-only Activity** with no WebView. Independently test an AppCompat-only Activity and a constructed/attached **but non-navigated** WebView. Require ActivityManager's provider section to be present and completely parsed; missing data is **unknown**, not proof of zero.
2. Cold-start the **minimal navigating WebView** with `loadData(..., "base64")` (a `data:` URL), or `loadUrl("about:blank")` separately, JavaScript disabled. Wait for navigation and capture the **original same-PID** provider reference strength/count using `adb shell dumpsys activity processes <debug-package>`. Do not mix observations from force-stopped/relaunched processes.
3. In another cold process, navigate then destroy the WebView as above, keeping the same Activity resumed; capture provider counts before and after. Verify teardown through a **fixed, same-PID** debug marker, not by elapsed time.
4. Record Android API, allowed-category WebView provider name/version, complete provider-list validity, and whether **stable/unstable** reference counts changed. Avoid uploading raw `dumpsys`, logcat, hardware serials, accounts, URLs or app-process IDs as public evidence.

The current harness's baselines are `FD00` / `FD00P` / `FD00C` / `FD00A` / `FD00N` / `FD00D` / `FD00S` / `FD00T` / `FD00W`. All are classified as **MEASURED**, never PASS or a waiver for strict FD01.

## Reproduced evidence

| Control | API34 Google WebView 113.0.5672.136 | API35 Google WebView 124.0.6367.219 |
|---|---|---|
| Native-only, AppCompat-only, un-navigated WebView | Verified **zero** FontsProvider links in compared baseline runs | Do not claim without inspecting that run's exact controls |
| Inert `data:` HTML navigation — FD00S | **1 STABLE** ref | **1 UNSTABLE** ref |
| Inert `about:blank`-based HTML — FD00D | **1 STABLE** ref | **1 UNSTABLE** ref |
| Same PID / foreground Activity, after `WebView.destroy()` — FD00T | **1 STABLE** ref persists | **0** refs, released |
| Actual Bridge after-login strict FD01 | **1 UNSTABLE** ref, **FAIL** (latest canonical #322); prior runs also observed 1 STABLE | **0** refs, **PASS** in one API35 experimental run |
| A01 cold-start, L01 HOT, L03 process recovery, ANR01 | Passed in the compared API34 run | Passed in the compared API35 run |

- API34 [Android run 39115534640](https://github.com/fatihcayiroglu/Bridge/actions/runs/39115534640): **33 PASS / 1 FD01 FAIL / 0 SKIPPED / 15 MEASURED**; [independent privacy PR #330 run 39118551989](https://github.com/fatihcayiroglu/Bridge/actions/runs/39118551989) **32 PASS / 1 FD01 FAIL / 0 SKIPPED / 4 MEASURED**, including a stable after-login ref on the unmodified main app.
- API35 [Android run 39117109756](https://github.com/fatihcayiroglu/Bridge/actions/runs/39117109756): **34 PASS / 0 FAIL / 0 SKIPPED / 15 MEASURED**.
- The Android 15 experiment passed its own Quality Gate and iOS workflows, but is closed without merge because it changed the test image and did not fix the application.

## What can, and cannot, be inferred

- **Observed:** WebView document navigation is sufficient to acquire FontsProvider without Bridge's JavaScript or Capacitor plugins on both images. AppCompat/activity construction alone did not suffice on the API34 image.
- **Observed:** Provider reference *strength and lifetime differ* between the tested images.
- **Android source mechanism:** Android's `ContentProviderHelper` can terminate a client whose provider connection has **stableCount > 0** when the providing process dies, with exit reason `REASON_DEPENDENCY_DIED`: https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/am/ContentProviderHelper.java
- **Not established:** The upstream provider of Bridge's separately recorded **reason 12 DEPENDENCY DIED** app-process exit. The matching provider-specific ActivityManager kill line was not captured in that historical run. No evidence proves that the FontsProvider reference caused the historical **FocusEvent/input_dispatch_timeout ANR**.
- **Not safe / not proposed:** Force-killing or disabling Google Play Services, injecting into WebView, blocking system fonts, changing OS-level provider ref counts or silently treating FD01 as PASS.

See Chromium's upstream description of supported WebView providers and variants: https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/webview-providers.md

## Required next acceptance before resolving #209

1. Confirm a **controlled same-OS Android 14** comparison with only a supported, signed, genuinely selectable WebView provider/version changed (if the chosen image allows it); otherwise mark the experiment **blocked** instead of installing arbitrary third-party APKs.
2. Capture a fresh genuine dependency-death event with a matched app PID, process name, exit time, and sanitized provider-specific `ActivityManager` kill line. If missing, attribute **unknown**.
3. Validate successful cold restart/session/channel/missed-message restoration after **real dependency death**, not merely a harness-invoked background `am kill`.
4. Reproduce the product on **physical Android hardware** and representative vendor/Google Play WebView releases. The current simulator is **not** physical-device acceptance.
5. Preserve the original Android **FD01, A01, L01 and ANR01** gate semantics, zero Android skipped tests, and historical red run evidence until a reviewed contract/mitigation demonstrates at least equivalent user-facing safety.

**Issue owner decision needed, not a test workaround:** determine whether `FD01 == zero OS-managed provider references at a single after-login instant` is a controllable app invariant for every supported WebView version. Any possible contract replacement requires a separate engineering decision supported by real-device crash/ANR/recovery acceptance. This document does **not** change that gate.
