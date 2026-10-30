# Android #209 — FontsProvider stable reference: upstream root cause and product mitigation

**2026-10-19 · root cause traced in upstream source, confirmed by a same-process intervention (FD00G) and a durably attributed DEPENDENCY DIED kill (FD00W) · product mitigation: 0 stable refs after login and FD01 PASS in four exact-head runs of the earlier `MIN_PRIORITY` pass and in the runs of the current `NORM_PRIORITY` pass (§4a) · #209 stays OPEN (FocusEvent ANRs, fixed-WebView and physical-device validation, FD01′ decision)**

Tracking issue: [#209](https://github.com/fatihcayiroglu/Bridge/issues/209). Diagnostic PR: [#322](https://github.com/fatihcayiroglu/Bridge/pull/322). Evidence dossier: [`P7_ANDROID_209_UPSTREAM_REPRODUCTION.md`](P7_ANDROID_209_UPSTREAM_REPRODUCTION.md).

## 1. Summary

The STABLE `com.google.android.gms.fonts` reference that FD00N/FD00D/FD00S/FD00W/FD00T and FD01 observe on the CI image (Android 14, Google APIs x86_64, **Android System WebView 113.0.5672.136**) comes from a **Chromium bug fixed in 117.0.5938.29 (M117 branch) and 118.0.5971.0 (trunk)**, with a partial, non-monotonic backport on M116 (present in 116.0.5845.124/.163/.188; absent up to .123 and from .140/.141/.150/.153). It isn't caused by Bridge code, Capacitor or AndroidX:

1. The renderer prefetches GMS downloadable fonts at startup.
2. Chromium opens each font through `ContentResolver.openFileDescriptor`. That returns a wrapper holding a **stable** provider reference.
3. Chromium 113 detaches the descriptor out of the wrapper without closing the wrapper. AOSP releases the wrapper's stable reference **only when the garbage collector finalizes it**.
4. While that stable reference exists, ActivityManager kills the app with **`REASON_DEPENDENCY_DIED` (12)** if the GMS process hosting the provider dies. Clients holding only an unstable reference are notified, not killed.

That one mechanism is consistent with every FontsProvider observation recorded so far (§3), including the intermittency of FD01. The reason-12 kills of unmitigated controls are attributed by exit description in FD00W (39254381137, 39256893223) and only by analogy for CS00 (39159049059). The product's own reason-12 death (A01, run 39067739321, subreason 0, before the mitigation) predates description attribution and remains **unattributed**: it is consistent with this mechanism, not proven to be it.

## 2. Upstream source chain (each link read in source, not inferred from timing)

| # | Step | Source |
|---|---|---|
| 1 | Renderer font init calls `FetchAllFontFiles` whenever `AndroidDownloadableFontsMatching` is enabled. This runs on the first navigation, which is when a renderer exists. | Chromium [`font_unique_name_lookup_android.cc` L117-128 @113.0.5672.136](https://github.com/chromium/chromium/blob/113.0.5672.136/third_party/blink/renderer/platform/fonts/android/font_unique_name_lookup_android.cc#L117-L128) |
| 2 | `AndroidFontLookupImpl` fetches Google Sans 400/500/700 and Noto Color Emoji Compat from `com.google.android.gms.fonts`. `tryFetchFont` opens the font with `contentResolver.openFileDescriptor(...)` (L257), caches a `dup()` (L263) and **returns the original wrapper** (L267). `fetchFontInBackground` passes it to `core.wrapFileDescriptor(fileDescriptor)` (L187). | Chromium [`AndroidFontLookupImpl.java` @113.0.5672.136](https://github.com/chromium/chromium/blob/113.0.5672.136/content/public/android/java/src/org/chromium/content/browser/font/AndroidFontLookupImpl.java#L187-L267) |
| 3 | `wrapFileDescriptor` calls `fd.detachFd()`. | Chromium [`CoreImpl.java` L173-176 @113.0.5672.136](https://github.com/chromium/chromium/blob/113.0.5672.136/mojo/public/java/system/src/org/chromium/mojo/system/impl/CoreImpl.java#L173-L176) |
| 4 | `openFileDescriptor` returns a `ParcelFileDescriptorInner`. That wrapper holds the **stable** provider and releases it only in `releaseResources()`. | AOSP [`ContentResolver.java` @android14-release](https://github.com/aosp-mirror/platform_frameworks_base/blob/android14-release/core/java/android/content/ContentResolver.java#L3907-L3922), `openTypedAssetFileDescriptor` |
| 5 | For a wrapping PFD (`mWrapped != null`), `detachFd()` returns `mWrapped.detachFd()` and **never calls the wrapper's `releaseResources()`**. Only `finalize()` does (L1073-1076). | AOSP [`ParcelFileDescriptor.java` L769-783 @android14-release](https://github.com/aosp-mirror/platform_frameworks_base/blob/android14-release/core/java/android/os/ParcelFileDescriptor.java#L769-L783) |
| 6 | When the last stable reference is released, ActivityThread converts it into **one unstable reference** and removes that after `CONTENT_PROVIDER_RETAIN_TIME = 1000` ms. | AOSP [`ActivityThread.java` @android14-release](https://github.com/aosp-mirror/platform_frameworks_base/blob/android14-release/core/java/android/app/ActivityThread.java#L290), `releaseProvider(..., stable)` |
| 7 | When a provider's process dies, clients with `conn.stableCount() > 0` are killed with `REASON_DEPENDENCY_DIED`. Unstable-only clients get `unstableProviderDied`. | AOSP [`ContentProviderHelper.java` L1794 @android14-release](https://github.com/aosp-mirror/platform_frameworks_base/blob/android14-release/services/core/java/com/android/server/am/ContentProviderHelper.java#L1794) |
| 8 | **Fix:** "Duplicate the ParcelFileDescriptor and close the original". It is absent through `117.0.5938.28` and present from `117.0.5938.29` (L263-265). The provider reference is released immediately. | Chromium [`AndroidFontLookupImpl.java` @117.0.5938.29](https://github.com/chromium/chromium/blob/117.0.5938.29/content/public/android/java/src/org/chromium/content/browser/font/AndroidFontLookupImpl.java#L263-L265) vs [@117.0.5938.28](https://github.com/chromium/chromium/blob/117.0.5938.28/content/public/android/java/src/org/chromium/content/browser/font/AndroidFontLookupImpl.java) |

The fix was located by tag bisection:

- **M117 branch:** `117.0.5938.0`–`.28` unfixed; `.29`, `.30`, `.60`, `.140` fixed.
- **Trunk:** `118.0.5939.0`–`118.0.5970.0` unfixed; `118.0.5971.0` and every later tag checked (5975, 5993, 120–140) fixed.
- **M116 (non-monotonic backport):** `116.0.5845.0`–`.123` unfixed; `.124`, `.163`, `.188` fixed; `.140`, `.141`, `.150`, `.153` unfixed. An M116 version number alone does not tell whether the build leaks.

The landing build on the M117 branch and on trunk is therefore known exactly; M116 has no single landing build. The individual Chromium commit could not be resolved from this environment, because `chromium.googlesource.com` and the GitHub API were not reachable.

### Reason-12 attribution (API 34)

In AOSP android14 exactly three code paths produce `REASON_DEPENDENCY_DIED`. Each writes its own kill reason into the durable `ApplicationExitInfo.description` (via `ProcessRecord.killLocked` → `noteAppKill(..., description)`), which `dumpsys activity exit-info` prints:

| Producer | Description | Subreason |
|---|---|---|
| `ContentProviderHelper.removeDyingProviderLocked` | `depends on provider <component> in dying proc <process> (adj N)` | 0 (UNKNOWN) |
| `ActivityManagerService.killPackageDependents` | `dep: <package>` | 0 (UNKNOWN) |
| SDK sandbox death | `sdk sandbox died` | 27 (SDK_SANDBOX_DIED) |

The historical CS00 death (`reason=12, subreason=0` in the blank-WebView control) is therefore either a stable-provider death or a `killPackageDependents` kill. It is not SDK-sandbox. The harness now classifies the description into fixed enums (commit `0d8f17a`), so the **next** reason-12 event names the dependency class without relying on rotating logcat.

## 3. How the mechanism accounts for the recorded observations

| Observation (API34 / WebView 113 unless noted) | Explanation |
|---|---|
| FD00 native-only, FD00P AppCompat-only, FD00C constructed-only, FD00A attached-not-navigated: **0 refs** | No navigation → no renderer → no `FetchAllFontFiles`. |
| FD00N / FD00D / FD00S / FD00W any navigation, JavaScript off: **1 STABLE** | The renderer starts and prefetches fonts; the leaked wrapper holds the stable reference. |
| FD00W: still **1 STABLE at 1.5, 4 and 8 s**, same PID | An idle Activity allocates almost nothing, so no GC runs and the wrapper is never finalized. |
| FD00T: **1 STABLE survives `WebView.destroy()`** | The reference belongs to an unreachable wrapper object, not to the WebView instance. |
| API35 / WebView **124**.0.6367.219: **1 UNSTABLE**, then **0** after teardown | Consistent with the fixed build closing the wrapper at once. Only a transient unstable reference is seen: the ≤1 s retain window or an in-flight query. |
| FD01 after login: sometimes **1 stable**, sometimes **0 stable / 1 unstable**, sometimes **0** | No GC yet; GC finalized the wrapper < 1 s before the sample (retain window); GC finalized it > 1 s before. Run 39160502999 shows the middle case, and FD02 saw **0** at +1.5 s on the same PID. |
| CS00 run 39159049059: **blank-WebView attempt 3 died, reason 12 / subreason 0**; native-only controls never died | Only the WebView control holds a stable FontsProvider reference. A GMS provider-process restart during that window kills the client with exactly this code. (The specific dying process was not captured in that run; see §5.) |

## 4. Product mitigation (commit `c30b815`)

`MainActivity` calls `WebViewFontProviderRelease.scheduleAfterFirstPageLoad` from Capacitor's `WebViewListener.onPageLoaded`. The routine:

- runs **once per process** and **only** when all of these hold:
  - the default user agent's `Chrome/x.y.z.w` is treated as leaking: anything below M117, including the M116 builds known to carry the backport (`116.0.5845.124`/`.163`/`.188`), because M116 is non-monotonic and the gate does not try to separate them; M117 below `117.0.5938.29`; M118 below `118.0.5971.0`. A reduced user agent (`117.0.0.0`, `118.0.0.0`) also counts as leaking. On a build that is in fact fixed the passes are unnecessary and cost four explicit GCs (cost note below). A missing or unparseable version is left alone.
  - `com.google.android.gms.fonts` resolves for this app. This uses the same visibility WebView's fetch has.
- on a **daemon thread at normal priority** (deliberately not a low priority, §4b), runs `gc(); runFinalization(); gc(); runFinalization()` at ≈1.5 s and ≈10 s after the first page load (sequential sleeps: 1.5 s, then 8.5 s after pass 1 ends). Apart from the GC pauses every explicit GC imposes on all threads (§4b), the main thread does nothing for it: no GC call, finalization wait, sleep or package-manager query. A `RuntimeException` inside the worker is swallowed (debug marker `stage=failed reason=exception`, never the exception text): the mitigation never takes the app down.
- touches **no** GMS state, provider, `ContentProviderClient`, ref count or WebView internals. It runs the finalizer AOSP already relies on, sooner, for an object Bridge never references.
- logs fixed markers (`BridgeFontRefRelease`, `stage=pass-complete pass=N passMs=… mainMaxGapMs=… baselineMaxGapMs=…`) only in debuggable builds. `mainMaxGapMs` is the worst delay of a 50 ms main-thread heartbeat while the pass ran; `baselineMaxGapMs` is the same over the 500 ms pass-free window just before it (§4b). A marker proves the pass ran, not that anything was released. Release builds sleep the same total time, log nothing and run no heartbeat.
- is **best effort**: a prefetch that completes after the last pass (a very slow GMS provider) keeps its stable reference until the next natural GC, i.e. the behaviour without the mitigation.

FD00G (commit `e93e311`) is the same-OS, same-WebView **intervention test** of the mechanism. It runs **the production pass** in a plain about:blank WebView that stays attached and referenced:

- If the stable reference is **gone** afterwards (same PID, after the 1 s retain window), it was held by finalizable garbage. That confirms that a finalizable, unreachable object held it, as the source chain predicts, and that the production pass releases it in this control. It does not exercise the production gate, schedule or thread; the product evidence for those is A01/FD01 (§4a).
- If it **persists**, the mechanism is refuted, and the mitigation must be reverted.

Cost on WebView treated as leaking (including fixed M116 builds): two passes per process, each `gc(); runFinalization(); gc(); runFinalization()`, i.e. **four explicit GCs and four finalization waits** on a worker thread. Each GC briefly suspends every thread, the main thread included (§4b). Measured on the CI emulator (debug build): 283 ms and 450 ms per pass (run 39259980396). On WebView recognised as fixed, the cost is one user-agent read on the main thread (plus a debug-only log line).

### 4a. CI evidence (API 34 emulator, WebView 113.0.5672.136)

| Observation | Before the mitigation (e.g. [39160502999](https://github.com/fatihcayiroglu/Bridge/actions/runs/39160502999)) | With it (`MIN_PRIORITY` pass): [39164884625](https://github.com/fatihcayiroglu/Bridge/actions/runs/39164884625) (`a9bd659`), [39166491452](https://github.com/fatihcayiroglu/Bridge/actions/runs/39166491452) (`bfb7177`), [39254381137](https://github.com/fatihcayiroglu/Bridge/actions/runs/39254381137) (`4603fe6`), [39256893223](https://github.com/fatihcayiroglu/Bridge/actions/runs/39256893223) (`5663710`); current `NORM_PRIORITY` pass: [39259980396](https://github.com/fatihcayiroglu/Bridge/actions/runs/39259980396) (`968d3fc`) |
|---|---|---|
| A01 first UI (product) | 1 **stable** / 0 unstable | **0 stable / 1 unstable**, `passes=1`, in all five runs: the ActivityThread stable→unstable retain window right after release pass 1 |
| FD01 after login | 0 stable / 1 unstable → **FAIL** | **0 / 0 → PASS**, `passes=2`, in all five runs |
| FD02 1.5 / 4 / 8 s | 0 | 0 |
| FD00W / FD00T (unmitigated controls) | 1 stable for 8 s; survives `destroy()` | unchanged: the platform leak itself is untouched. FD00W was **killed by DEPENDENCY DIED in the last two runs** (below) |
| CS01, L01 (HOT), L03, L04, ANR01 | — | PASS in all five runs; ANR02 found 0 fatal ANRs (in run 39254381137 its coverage was honestly `possibly-truncated`: 16/16 records). CS00 is a MEASURED control, not a PASS; in run 39256893223 all six of its cold starts kept their PID |

**Same-process intervention, FD00G (run 39254381137).** A plain about:blank WebView stays attached and referenced, and the production pass runs on the same PID:

- `before`: **stableRefs=1**, unstableRefs=0. `baselineBeforePass=true`, one Activity instance, `webViewAttached=true`.
- The pass completes (`finalized`, `passMs=36`).
- `after`: **stableRefs=0**, unstableRefs=1.

The stable reference was held by finalizable garbage, not by the live WebView. This is the controlled experiment the source analysis predicted. Run 39256893223 repeated it on the next commit: **stableRefs 1 → 0** on the same PID, `passMs=29`, no stall and no uncaught marker.

The two earlier "started but not finalized" FD00G results are analysed in §4b.

**The kill path, attributed durably: FD00W (run 39254381137).** During its 8 s observation, the **unmitigated** plain-WebView control, holding the leaked stable ref, was killed. The durable `ApplicationExitInfo.description` classifies the exit as:

- `reason=12 DEPENDENCY DIED`, `subreason=0`
- `provider-death`, `providerClass=gms-fonts`, `dyingProcessClass=gms-persistent`
- `attribution=exit-description`

That is ActivityManager killing a stable FontsProvider client because `com.google.android.gms.persistent`, the process hosting the GMS FontsProvider, died. It is the same Activity (`WebViewBaselineActivity`) and the same reason and subreason as the earlier CS00 blank-WebView death ([39159049059](https://github.com/fatihcayiroglu/Bridge/actions/runs/39159049059)). Why GMS persistent died is not observable from the app and was not investigated: no GMS internals are touched.

Run 39256893223 recorded the identical kill of the identical control: reason 12, subreason 0, `provider-death`, `gms-fonts`, `gms-persistent`, `exit-description`.

Each of the four earlier runs (product journeys and controls still in one suite) is **34 PASS / 1 FAIL / 0 SKIPPED / 16 MEASURED**, and every FAIL is an unmitigated upstream control, never a product journey:

- In runs 39164884625 and 39166491452 the FAIL is FD00G, the uninstrumented stall (§4b).
- In runs 39254381137 and 39256893223 the FAIL is **FD00W**: the unmitigated control's process was killed by DEPENDENCY DIED. By design, a control whose process vanishes is a FAIL, and it was not relabelled.

On the owner's decision these controls now run in a separate non-gating diagnostic workflow, still as real FAILs (§4c).

### 4b. FD00G stalls and main-thread safety of the production pass

**What was observed.** In runs 39164884625 and 39166491452, the FD00G control logged `started` but not `finalized` within ~13 s. Neither run had stall, liveness or exit instrumentation, so neither can tell a pass that blocked from a control process that was killed. Both instrumented runs since (39254381137, 39256893223) finished the same pass in 36 ms and 29 ms with no stall or watchdog marker. The product's own pass completed in every run, and the product process survived.

**What was ruled out, by reading source:**

- Contention on ActivityManager's global lock. Releasing a provider reference ends in `ActivityManagerService.refContentProvider`, which adjusts the connection's counts without taking that lock.
- A starved finalizer. ART's FinalizerDaemon and ReferenceQueueDaemon run at normal priority, as did FD00G's pass thread.

**What remains possible:** the control process was killed mid-pass, or a finalizer ran long. The kill is plausible: FD00W and CS00 show that exactly this kind of unmitigated control, holding the leaked stable ref, gets DEPENDENCY DIED kills on this image. A kill before the `finalized` marker is indistinguishable from a stall in those two runs. This is consistent but **unproven**. The diagnostic workflow runs FD00G three times per run (nightly once it is on the default branch; on this PR only because the workflow file changed) with:

- a stall snapshot of the pass thread, FinalizerDaemon and ReferenceQueueDaemon;
- FinalizerWatchdog and uncaught-exception markers;
- liveness and exit attribution.

**A production risk was inferred from ART's GC design and reduced, not eliminated.** The production pass thread was `MIN_PRIORITY`. An explicit GC suspends every thread, the main thread included, for its brief flip, and only the GC thread can resume them. A nice-19 thread descheduled by CPU contention would therefore stall the UI: a priority inversion that could turn into jank or an ANR on a busy device. The pass now runs at `NORM_PRIORITY`, as ART's own HeapTaskDaemon and FinalizerDaemon do. This is a design argument, not a measured comparison: NORM_PRIORITY narrows the window and trades it for ordinary CPU contention; it does not guarantee that the GC thread is never preempted while other threads are suspended.

Apart from GC pauses, the main thread does no work for the pass:

- `System.runFinalization()` blocks only the calling worker.
- The main thread only reads the user agent and starts the thread.
- Source-contract tests keep `resolveContentProvider`, sleeps, `gc()` and `runFinalization()` out of the main-thread part.

**Evidence and gates.**

- **Measured on head `968d3fc` (run 39259980396, debug build, API 34 emulator):** pass 1 `maxPassMs=283`, `maxMainGapMs=233` (first UI); after pass 2 `maxPassMs=450`, `maxMainGapMs=245` (FD01). The main-thread heartbeat was delayed by about 0.23–0.25 s while a pass ran, during app startup and login. That run cannot attribute the gap to the pass rather than concurrent startup or login work: it had no pass-free baseline. FD00G's 19–36 ms passes ran in an idle about:blank Activity and are not evidence for the product pass.
- **Attribution measurements (added after that run, debug only, MEASURED):**
  - each pass marker now carries `baselineMaxGapMs`, the same heartbeat over the 500 ms pass-free window that ends when the pass starts. FD01's facts expose per-pass `passTimings` plus `maxBaselineGapMs`. The baseline window is at least as long as the measured passes, so a pass gap clearly above its baseline points at the pass;
  - `explicitGc` reads ART's own log line for each explicit GC in the exact app process (`Explicit … GC freed … paused … total …`): `explicitGcs` (expect 2 per completed pass), `maxPauseMs` and `sumPauseMs` (time ART suspended all threads) and `maxGcTotalMs` (GC wall time). Pauses far below the heartbeat gap would mean the gap is CPU contention or unrelated main-thread work, not a GC suspension.
- The meter reads 0 for a pass shorter than its first 50 ms tick, and counts main-thread delay from any cause; a heartbeat past its 30 s cap no longer reports a false gap.
- These facts are MEASURED, not asserted: one run of each is not a baseline, and a threshold chosen without one would be arbitrary.
- The strict gates stay unchanged: ANR01 (no OS-reported ANR), CS01 (cold starts PID-stable, no ANR), L01 (HOT resume, PID-stable). They catch ANR-length stalls (about 5 s) and process loss only, not sub-second main-thread stalls.

### 4c. Gating after the owner's decisions (2026-10-19)

- **Product suite** (`mobile-android.yml`, `ANDROID_JOURNEY_SUITE=product`, required): every Bridge journey and gate as before, including A01, CS01, A02, FD01 (unchanged), L01–L04 and ANR01. Plus **PD01**: the Bridge process must never exit with reason 12 (DEPENDENCY DIED) during the journeys.
  - PD01 reads `dumpsys activity exit-info` after startup, after the lifecycle journeys and at the end.
  - It de-duplicates the records and counts only those after the device-clock journey start.
  - It attributes any reason-12 record from its durable description.
  - It FAILs when the history is unreadable or the journey window is unknown, when any row cannot be parsed (no timestamp, or a Bridge row without a numeric PID) or carries an unknown reason, and when no Bridge exit at all was seen in the journey (the harness itself force-stops the app, so zero means the read is broken).
  - It FAILs when exits may have been evicted unread. Android keeps **one 16-record history per package, shared by the main process and WebView's sandboxed renderer processes**, so continuity is judged on every process's rows: each read must still contain the newest row already seen, and a first read of a full history must reach back before the journey start. (An earlier version looked only at Bridge-process rows and could not detect eviction by renderer rows; found in review and fixed with a regression test.) Unverifiable is never a PASS.
- **Upstream WebView controls** (`android-upstream-webview-diagnostics.yml`, `ANDROID_JOURNEY_SUITE=upstream-webview-controls`, nightly and on demand, not required): FD00, FD00P/C/A/N/D/S/T, FD00G ×3, FD00W and CS00.
  - These are unmitigated debug Activities without Bridge code.
  - A control FAIL is still a FAIL: the job exits nonzero and its summary says so.
  - Nothing there is counted in, or excused by, the product totals.

Found and fixed on the way: `parseApplicationExits` read crash exits (`reason=4 (APP CRASH(EXCEPTION))`, `5 (APP CRASH(NATIVE))`) as reason 0, because the nested parenthesis made its regex fall through to `subreason=`. Any earlier "reason 0" process loss in #209 evidence must be re-read with this in mind.

## 5. Hypotheses disproven or narrowed

- **Bridge JS, Capacitor plugins, EmojiCompat or AppCompat start the connection.** Disproven: FD00N/D/S/W connect without any of them; FD00 and FD00P do not. EmojiCompat is not configured (FD01 native probe). The emoji2 initializer was already removed in #316.
- **WebView attachment or a View is required.** Disproven: FD00N, navigated but never attached, connects.
- **`WebView.destroy()` releases the dependency.** Disproven (FD00T). The source shows why: the holder is not the WebView.
- **An unstable FD01 reference is a kill risk.** Disproven by AOSP: only `stableCount() > 0` clients are killed.
- **The FontsProvider reference causes the FocusEvent ANRs (reason 6).** Not supported. In run 39038117703, FD02 saw **zero** references at 1.5, 4 and 8 s on the very PID that later hit the FocusEvent ANR at L01. The ANRs remain open and unexplained: this one run argues against, but does not exclude, a FontsProvider link, and no cause of the FocusEvent ANRs is proven.
- **CS00's death came from the SDK sandbox.** Disproven: subreason 0, and that path writes subreason 27.

**Settled:** FD00W in run 39254381137 is a durably attributed GMS-FontsProvider provider-death kill of an unmitigated WebView control, not a `killPackageDependents` package update and not the SDK sandbox. The earlier CS00 event predates description attribution. It is attributed only by its identical control, reason and subreason, not by its own description. The product A01 reason-12 exit in 39067739321 is likewise unattributed.

## 6. FD01 contract — analysis for owner review (FD01 is NOT changed here)

FD01 currently requires **zero** FontsProvider connections, stable *or unstable*, at one instant after login. AOSP shows:

- every release of a stable reference passes through a 1000 ms unstable state, and
- unstable references never cause a dependency-death kill.

So the zero-at-an-instant check can fail on a state with no kill risk, depending only on GC timing. Run 39160502999 is exactly this case: FD01 failed with 0 stable / 1 unstable, and FD02 measured 0 at +1.5 s.

Proposed equally strict replacement, requiring owner approval before any change:

- **FD01′:** zero **stable** FontsProvider references after login, on the same PID.
- **FD02′:** no stable reference at 1.5, 4 and 8 s on the same PID, and no unstable reference by 8 s (stricter than today: FD02 is measurement-only).
- **CS01, L01 (HOT, PID-stable), ANR01, A01, L03/L04 recovery** unchanged.
- Plus a reason-12 gate: any Bridge exit with reason 12 during the journey is a FAIL, reported with its classified description.

FD01 stays as written: on the owner's decision (2026-10-19) it is not changed until FD01′ has been validated on a fixed-WebView image and on physical devices. The reason-12 gate is implemented independently as PD01 (§4c) and does not replace FD01. With the mitigation in place, FD01 should now pass for a real reason, since the stable reference is gone. A pass on one run proves nothing permanent.

## 7. Remaining work before #209 can close

1. ~~Show stable → 0 on the same PID with the WebView alive~~ **done** (FD00G, runs 39254381137 and 39256893223). **Open:** classify any recurrence of the two earlier "started but not finalized" results with the nightly instrumentation (§4b). If the forced pass is ever seen to wedge or kill a WebView-113 process, the production mitigation must be revisited.
2. Product evidence: four exact-head runs of the earlier `MIN_PRIORITY` pass (39164884625, 39166491452, 39254381137, 39256893223) and the run of the current pass (39259980396: 35 PASS / 0 FAIL / 0 SKIPPED / 6 MEASURED, PD01 PASS, `maxPassMs` 450, `maxMainGapMs` 245) all show 0 stable refs after login and FD01 PASS. That is consistency on one emulator image, not permanence. PD01 must hold across further product runs. Attribute the 0.23–0.25 s main-thread gaps with `baselineMaxGapMs` and ART's explicit-GC pauses before turning any of them into an asserted bound.
3. A **fixed-WebView** image (e.g. API 35, WebView 124) must show no stable reference in FD00W/FD00T without any mitigation, and the mitigation must report `skipped webview-not-affected`.
4. **Physical devices** with current Play-updated WebView, plus one GMS device with a frozen WebView that lacks the fix (e.g. 113.x, or M116 up to `116.0.5845.123`; not `.124`/`.163`/`.188`, which carry the backport) if obtainable. No physical-device testing has been done.
5. The **FocusEvent ANRs** (reason 6) need their own main-thread evidence. ANR02 classifies fatal ANR traces app-locally, and it cannot see non-fatal ANRs or exits evicted from Android's 16-record history. **First recurrence with ANR02 evidence (2026-10-23):** see §8. The cause is still unproven.
6. Owner decision on the FD01′ contract (§6).
7. ~~Owner decision on the unmitigated controls~~ **decided 2026-10-19:** they moved to the non-gating nightly diagnostic workflow, with their FAILs and nonzero exit status preserved (§4c). Its schedule only runs from the default branch; on this PR it runs because the workflow file changed.

## 8. Recurrence with ANR02 evidence (2026-10-23, run 40020150345)

Mobile Android [run 40020150345](https://github.com/fatihcayiroglu/Bridge/actions/runs/40020150345) on `eae5a1f3` (P7-D2 media expiry, #370) reported 33 PASS and 3 FAIL: CS01, L01 and ANR01. From the job log, all three are **one** OS-recorded ANR:

| Evidence | Value |
|---|---|
| CS01 | `cold start 3: ActivityManager reported an app ANR` |
| L01 | `pidStable: false`, `launchState: COLD`; `ApplicationExitInfo` shows pid 5802 `reason 6 (ANR)` at 20:42:30.653, during L01's 20 s background |
| ANR01 category | `input_dispatch_timeout`, `focusEvent: true` (the historical #209 signature) |
| ANR02 (first trace since it was added) | `fatalAnrs: 1`, main thread `mainState: Native`, `top: running-code`, `subsystem: framework-only`: no Bridge or WebView frame on top |
| CPU at the ANR | total 98–99 %, app 46–52 %, `system_server` 26 %, WebView renderer 0 % |
| Kernel load average | 23.51 / 10.34 / 3.91 before L01, 18.47 after (2.8 GB emulator) |

These facts rule out the following:
- **The commit under test.** `eae5a1f3` changes no client, mobile or Android file; its diff from #369 (`093099b0`) is server code, tests and docs only. No client code calls the voice HTTP routes, and these journeys join no voice.
- **A reproducible regression on that code.** The same runtime code (`1fceb3a4`, a doc and test change only) passed every journey in [40024498508](https://github.com/fatihcayiroglu/Bridge/actions/runs/40024498508), with `fatalAnrs: 0`. Base #369 passed in [40024502211](https://github.com/fatihcayiroglu/Bridge/actions/runs/40024502211), also with `fatalAnrs: 0`. The next code change (`4601e0bf`) passed in [40029695493](https://github.com/fatihcayiroglu/Bridge/actions/runs/40029695493).

These remain unknown:
- the cause, and whether the CPU starvation (load ≈ 23, 98 % CPU) is cause or symptom;
- why a framework-only main thread missed a focus-event dispatch.

It is **not** classified as a flake. It is a recurrence of this open item, and CS01/L01/ANR01 remain gating: a run that shows it is red.
