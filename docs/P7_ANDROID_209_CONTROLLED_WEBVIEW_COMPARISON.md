# Android #209 — controlled WebView comparison (one intended variable)

**2026-10-20 · predictions recorded before the first run · two runs: the main prediction held in both, one auxiliary prediction (FD00C/FD00A) missed in both · AUTOMATED / EMULATOR only · #209 stays OPEN**

Tracking issue: [#209](https://github.com/fatihcayiroglu/Bridge/issues/209). Root cause and mitigation: [`P7_ANDROID_209_ROOT_CAUSE.md`](P7_ANDROID_209_ROOT_CAUSE.md).

## Question

Does the STABLE `com.google.android.gms.fonts` reference, and the DEPENDENCY DIED exposure it creates, follow the **WebView (Chromium) version** alone? The source analysis says yes: the leak is in Chromium's `AndroidFontLookupImpl` and is fixed from `117.0.5938.29` / `118.0.5971.0`. Earlier cross-image evidence (API 34 + WebView 113 against API 35 + WebView 124) changed the OS, Play services and WebView together, so it could not isolate the WebView.

## Arms

| Arm | OS image | Play services | WebView provider | Bridge APK | Where |
|---|---|---|---|---|---|
| A | API 34 Google APIs x86_64 (CI image) | image's own | image's own `com.google.android.webview` **113.0.5672.136** (unfixed) | same debug APK | `controls` job, `system` |
| B | same | same | **Chromium SystemWebView 158.0.8114.0** (`com.android.webview`), selected with `cmd webviewupdate set-webview-implementation` | same | `controls` job, `chromium-fixed`; `product-fixed-webview` job |
| C | API 35 Google APIs x86_64 | image's own | image's own WebView 124.0.6367.219 (fixed) | — | historical only ([#329](https://github.com/fatihcayiroglu/Bridge/pull/329), run 39117109756); changes three variables, not re-run here |

The WebView provider is the intended variable. The OS image, Play services, emulator options (`-gpu swiftshader_indirect`, pixel_6, 2 vCPUs) and the APK are the same. It is not the only difference between A and B: arm B alone removes a possible WebView command-line file, starts its journeys later after boot and has the switch's background RELRO preparation (§ Confounds).

**The fixed WebView build.** It is revision r1722592 of the Chromium project's continuous (snapshot) builder `AndroidDesktop_x64`, from the `chromium-browser-snapshots` bucket. That is a desktop-Android build, not a release channel and not a Google WebView release. Two values are pinned in the workflow, the archive SHA-256 (`97bb6b0d…228a`) and the APK SHA-256 (`28d6eaf5…6369`), so a different file fails the job before anything is installed.

Its `SystemWebView.apk` is 418,158,473 bytes. It declares minSdk 29 and targetSdk 36, and carries x86 and x86_64 native libraries. These facts come from a local read on 2026-10-20 of a copy whose SHA-256 matches both pins: its binary manifest was parsed, and its `lib/` entries were listed. CI does not show them yet. In runs 39398677365 and 39433154544 the badging filter printed only `targetSdkVersion:'36'` and `native-code: 'x86_64'`. aapt2 prints the min SDK as `minSdkVersion:` and the second ABI as `alt-native-code:`, and the filter dropped both lines. With this change, `fetch-pinned-webview.sh` prints them in later runs.

From source reading (not measured here): Chromium `main` keeps `AndroidDownloadableFontsMatching` enabled by default and still prefetches through `FetchAllFontFiles`, with the dup-and-close fix. When the font fetch is triggered differs between the two builds in the observed data (§ Results, FD00C/FD00A).

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
- **Arm-B-only procedure.** Only arm B runs `select-webview-provider.sh`. Arm A gets no matching no-op step. The script:
  - removes a possible `/data/local/tmp/webview-command-line` file (whether one existed is not recorded);
  - installs the 418 MB APK and switches the provider. From its first log line to its status line this took 21.0 s, 25.8 s, 22.2 s and 29.8 s (jobs 118548881167, 118548880764, 118664842472, 118664842512), so arm-B journeys start that much later after boot;
  - triggers the switch's background RELRO preparation for the new provider. This comes from AOSP source and is not measured or awaited here.
- **Desktop-Android build configuration.** The snapshot is built for `AndroidDesktop_x64`. Its build arguments are not recorded, and its package name (`com.android.webview`) differs from Google's.
- **Two runs are two samples.** Repeat before drawing conclusions about intermittent behaviour (FD01 intermittency, DEPENDENCY DIED timing, ANRs).
- **Arm identity in these two runs.** Neither run had WV00/WV01. In both runs the arm rests on the select script's read-back (`com.android.webview@158.0.8114.0`) and on the harness's device facts: `google-webview` 113.0.5672.136 in jobs 118548880771 and 118664844269, `aosp-webview` 158.0.8114.0 in the four arm-B jobs. From the next run on, WV00 asserts each arm's exact provider (system: `google-webview` 113.0.5672.136; chromium-fixed: `aosp-webview` 158.0.8114.0). A different version on either arm, such as an image update or another snapshot build, fails WV00 until the experiment is updated and WV01 asserts the product-arm mitigation skip. Both are counted in that job's totals, so the totals below are not directly comparable with later runs.

## Not covered

- **Physical devices:** none available. No device result exists or is implied.
- **A Google-built fixed WebView on API 34:** not obtainable here. Google's WebView is distributed only through Play.
- **Arm C:** it is not re-run here, because it changes the OS, Play services and WebView together.

## Results

Filled in from CI job logs only. First run: [39398677365](https://github.com/fatihcayiroglu/Bridge/actions/runs/39398677365), head `f1706a2`, `workflow_dispatch`, all three jobs on the same API 34 image. `f1706a2` is not in this branch's history after the rebase. Its tree equals the first PR commit `57abfab5`. From `f1706a2` to `1e06f348` only this doc, the CPU-class regex in `exit-diagnostics.mjs` and its test change, so the workflow and scripts it ran are those at `1e06f348`. The harness differs only in the ANR CPU-class regex, which does not affect any FD00*, CS00 or product reference count reported here. Second run, at the exact head: see below.

**The provider switch worked.** The image's configured provider list contains `com.android.webview` (listed as not installed before the install, valid after it). The selection read back as `com.android.webview@158.0.8114.0`; the harness's device facts show `aosp-webview` 158.0.8114.0. Both pinned hashes verified.

| Observation | Arm A, WebView 113 (job 118548880771) | Arm B, WebView 158 (jobs 118548881167, 118548880764) | Prediction |
|---|---|---|---|
| FD00 / FD00P (no WebView) | 0 | 0 | held |
| FD00C / FD00A (WebView constructed or attached, not navigated) | 0 | **0 stable / 1 unstable** | **missed**: predicted 0, observed 0 stable / 1 unstable (see below) |
| FD00N / FD00D / FD00S (navigated) | **1 STABLE** | 0 stable / 1 unstable | held |
| FD00W at 1.5 / 4 / 8 s | **1 STABLE** at every sample | 0/1 at 1.5 s, then 0/0 and 0/0 | held for stable (0 at every sample); the unstable reference outlived the ~1 s retain window (see below) |
| FD00T after `WebView.destroy()` | **1 STABLE survives** | 0 | held |
| FD00G ×3 (forced finalization) | stable 1 → 0 on the same PID | 0 stable before; nothing to release | held |
| CS00 cold starts | 6/6 PID-stable, 0 ANRs | 6/6 PID-stable, 0 ANRs | — |
| Product: release-pass marker | not run (no arm-A product job in this workflow) | **`stage=skipped reason=webview-not-affected`** at first UI and after login | held |
| Product: refs at first UI / after login | not run | **0/0 and 0/0** without any pass | held |
| Product: totals | not run | **35 PASS / 0 FAIL / 0 SKIPPED / 6 MEASURED**; FD01, PD01, ANR01 (0), CS01 (3/3 PID-stable), L01 (HOT) PASS | — |
| Controls totals | 0 / 0 / 0 / 13 MEASURED | 0 / 0 / 0 / 13 MEASURED | — |

Context only, outside the controlled comparison (a different commit and a different workflow): the required product job on `main`, run [39432574356](https://github.com/fatihcayiroglu/Bridge/actions/runs/39432574356) job 118663089408 (head `e4943214`, `google-webview` 113.0.5672.136), logged first UI 0 stable / 1 unstable after release pass 1, and after login 0/0 after pass 2. That job FAILED CS01, L01 and ANR01 (32 / 3 / 0 / 6).

**FD00W timing.** The 1.5 s sample is taken 1.5 s after FD00W's first sample. That first sample is taken after `am start -W` returns, a 2 s wait and a `dumpsys` read, so the 1.5 s sample comes at least about 3.5 s after the launch returned. The unstable reference was still there (1) and was gone by the 4 s sample. The pre-registered FD00W prediction was only "0 stable at every sample", and that held. The "at most a transient unstable reference in the 1 s retain window" wording belongs to the navigated-controls row. As observed, the unstable reference lasted longer than that window would allow for a stable reference released at launch. When it was acquired or released was not measured, so the 1 s window itself could not be checked.

**Second run:** [39433154544](https://github.com/fatihcayiroglu/Bridge/actions/runs/39433154544), exact head `1e06f348` (`pull_request`). It repeated the comparison with one extra event: an arm-A DEPENDENCY DIED kill.

| Observation | Arm A, WebView 113 (job 118664844269) | Arm B, WebView 158 (jobs 118664842472, 118664842512) |
|---|---|---|
| Navigated controls, FD00W, FD00T | 1 STABLE (FD00W 1 stable at 1.5 / 4 / 8 s; survives `destroy()`) | 0 stable everywhere; the same unstable-only pattern, FD00C/FD00A included |
| FD00G | **repetition 1 FAIL**: its pre-pass sample showed 1 stable / 0 unstable; the finalization pass never started; the process was gone with **exit reason 12 DEPENDENCY DIED**, `provider-death`, provider `gms-fonts`, dying process `gms-persistent`, `attribution=exit-description`. Repetitions 2–3: stable 1 → 0 | 0 stable before; nothing to release |
| CS00 cold starts | 6/6 PID-stable, 0 ANRs | 6/6 PID-stable, 0 ANRs |
| Totals | **0 PASS / 1 FAIL / 0 SKIPPED / 12 MEASURED** (the kill is a FAIL by design, never relabelled) | controls 0 / 0 / 0 / 13 MEASURED; product **35 / 0 / 0 / 6**, release pass `skipped reason=webview-not-affected` at both stages with 0 passes, FD01 PASS (0/0), first UI 0 stable / 1 unstable |

In that run the unfixed arm's FD00G control was killed with DEPENDENCY DIED by a `gms-fonts` provider death. Its last sample before the kill showed the leaked stable reference. AOSP kills a client on provider death only when it holds a stable reference (`stableCount() > 0`; [root cause, row 7](P7_ANDROID_209_ROOT_CAUSE.md)), so the kill is consistent with that reference still being held. The fixed arm, on the same image and Play services, showed no stable reference at any sample. Across the two runs, every arm-B **control** observation repeated. In the product suite, the first-UI stage differed: 0/0 in run 1 (job 118548880764) and 0 stable / 1 unstable in run 2 (job 118664842512). After login it was 0/0 both times, and no stable reference was ever seen.

## Summary of both runs

Runs [39398677365](https://github.com/fatihcayiroglu/Bridge/actions/runs/39398677365) and [39433154544](https://github.com/fatihcayiroglu/Bridge/actions/runs/39433154544), same API 34 image and Play services:

- **Arm A (113).** 1 STABLE reference in every navigated control, in FD00W at every sample and after `destroy()`, in both runs (jobs 118548880771, 118664844269). In run 39433154544, job 118664844269, FD00G repetition 1 was killed with DEPENDENCY DIED (reason 12, `gms-fonts` provider death) while its last sample showed that reference.
- **Arm B (158).** 0 stable at every sample of every control, and an unstable reference in every WebView control, in both runs (jobs 118548881167, 118664842472). The product suite passed 35 / 0 / 0 / 6 in both runs (jobs 118548880764, 118664842512), with the mitigation reporting `skipped reason=webview-not-affected` and no pass, and FD01 at 0/0.
- **Predictions.** The main prediction (no STABLE reference on 158) held in both runs. The FD00C/FD00A prediction (0 on 158) missed in both.

**Reading.** On the same OS image, Play services and APK, the STABLE FontsProvider reference appeared with WebView 113 and did not appear at any sample with WebView 158. On 158 an unstable reference was observed in every WebView control. That is consistent with the font fetch having run, and it is what the pre-registered rule uses to tell this result from "inconclusive". It does not prove the fetch ran: the probe reports connections and reference counts, not the caller. The result fits the source analysis (inference): the stable reference follows the WebView (Chromium) version. The limits: two runs per arm, two WebView versions, and a Chromium desktop-Android snapshot build rather than Google's (§ Confounds). That is support, not proof for every Google WebView release.

**Prediction missed: FD00C/FD00A.** The pre-registered value was 0 in both arms. On 158, in both runs, both controls showed 0 stable / 1 unstable without any navigation; 113 shows 0/0. So on 158 the provider was contacted when a WebView was constructed (observed). Why is not established. A fetch trigger that moved earlier in newer Chromium, a renderer started at construction, or the desktop-Android build configuration would all fit the data.

**What the 158 samples do and do not show.** No stable reference was observed at any sample on 158. That does not establish zero DEPENDENCY DIED exposure on 158. AOSP kills only clients with `stableCount() > 0` when the provider dies, and an unstable-only client gets `unstableProviderDied` instead ([root cause, row 7](P7_ANDROID_209_ROOT_CAUSE.md)). But the samples are discrete, so they cannot exclude a short-lived stable reference between samples, for example while a font file is open. That window is not measured here.
