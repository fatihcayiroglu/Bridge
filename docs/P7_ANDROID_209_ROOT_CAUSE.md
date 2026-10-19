# Android #209 — FontsProvider stable reference: upstream root cause and product mitigation

**2026-10-19 · root cause traced in upstream source, confirmed by a same-process intervention (FD00G) and a durably attributed DEPENDENCY DIED kill (FD00W) · product mitigation observed working in three exact-head CI runs · #209 stays OPEN (FocusEvent ANRs, physical devices, owner decisions)**

Tracking issue: [#209](https://github.com/fatihcayiroglu/Bridge/issues/209). Diagnostic PR: [#322](https://github.com/fatihcayiroglu/Bridge/pull/322). Evidence dossier: [`P7_ANDROID_209_UPSTREAM_REPRODUCTION.md`](P7_ANDROID_209_UPSTREAM_REPRODUCTION.md).

## 1. Summary

The STABLE `com.google.android.gms.fonts` reference that FD00N/FD00D/FD00S/FD00W/FD00T and FD01 observe on the CI image (Android 14, Google APIs x86_64, **Android System WebView 113.0.5672.136**) comes from a **Chromium bug fixed in 117.0.5938.29 (M117 branch) and 118.0.5971.0 (trunk)**. It isn't caused by Bridge code, Capacitor or AndroidX:

1. The renderer prefetches GMS downloadable fonts at startup.
2. Chromium opens each font through `ContentResolver.openFileDescriptor`. That returns a wrapper holding a **stable** provider reference.
3. Chromium 113 detaches the descriptor out of the wrapper without closing the wrapper. AOSP releases the wrapper's stable reference **only when the garbage collector finalizes it**.
4. While that stable reference exists, ActivityManager kills the app with **`REASON_DEPENDENCY_DIED` (12)** if the GMS process hosting the provider dies. Clients holding only an unstable reference are notified, not killed.

That one mechanism accounts for every FontsProvider observation recorded so far (§3), including the intermittency of FD01 and the reason-12 death of the **minimal WebView** control in CS00.

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

The landing build on each line is therefore known exactly. The individual Chromium commit could not be resolved from this environment, because `chromium.googlesource.com` and the GitHub API were not reachable.

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
  - the default user agent's `Chrome/x.y.z.w` is a build not known to contain the fix: anything below M117; M117 below `117.0.5938.29`; M118 below `118.0.5971.0`. Builds older than any tag read are conservatively treated as leaking; an extra GC is harmless. A missing or unparseable version is left alone.
  - `com.google.android.gms.fonts` resolves for this app. This uses the same visibility WebView's fetch has.
- on a **daemon, minimum-priority thread**, runs `gc(); runFinalization(); gc(); runFinalization()` at ≈1.5 s and ≈10 s after the first page load.
- touches **no** GMS state, provider, `ContentProviderClient`, ref count or WebView internals. It runs the finalizer AOSP already relies on, sooner, for an object Bridge never references.
- logs fixed markers (`BridgeFontRefRelease`, `stage=pass-complete`) only in debuggable builds. A marker proves the pass ran, not that anything was released. Release builds log nothing.
- is **best effort**: a prefetch that completes after the last pass (a very slow GMS provider) keeps its stable reference until the next natural GC, i.e. the behaviour without the mitigation.

FD00G (commit `e93e311`) is the same-OS, same-WebView **intervention test** of the mechanism. It runs **the production pass** in a plain about:blank WebView that stays attached and referenced:

- If the stable reference is **gone** afterwards (same PID, after the 1 s retain window), it was held by finalizable garbage. That confirms the mechanism and the mitigation.
- If it **persists**, the mechanism is refuted, and the mitigation must be reverted.

Expected cost on affected WebView: two explicit GCs per process, off the main thread. On fixed WebView (any up-to-date Play-updated device) the cost is zero: a single UA check.

### 4a. CI evidence (API 34 emulator, WebView 113.0.5672.136)

| Observation | Before the mitigation (e.g. [39160502999](https://github.com/fatihcayiroglu/Bridge/actions/runs/39160502999)) | With it: [39164884625](https://github.com/fatihcayiroglu/Bridge/actions/runs/39164884625) (`a9bd659`), [39166491452](https://github.com/fatihcayiroglu/Bridge/actions/runs/39166491452) (`bfb7177`), [39254381137](https://github.com/fatihcayiroglu/Bridge/actions/runs/39254381137) (`4603fe6`) |
|---|---|---|
| A01 first UI (product) | 1 **stable** / 0 unstable | **0 stable / 1 unstable**, `passes=1`, in all three runs: the ActivityThread stable→unstable retain window right after release pass 1 |
| FD01 after login | 0 stable / 1 unstable → **FAIL** | **0 / 0 → PASS**, `passes=2`, in all three runs |
| FD02 1.5 / 4 / 8 s | 0 | 0 |
| FD00W / FD00T (unmitigated controls) | 1 stable for 8 s; survives `destroy()` | unchanged: the platform leak itself is untouched |
| CS00, CS01, L01 (HOT), L03, L04, ANR01 | — | PASS in all three runs; ANR02 found 0 fatal ANRs (in run 39254381137 its coverage was honestly `possibly-truncated`: 16/16 records) |

**Same-process intervention, FD00G (run 39254381137).** A plain about:blank WebView stays attached and referenced, and the production pass runs on the same PID:

- `before`: **stableRefs=1**, unstableRefs=0. `baselineBeforePass=true`, one Activity instance, `webViewAttached=true`.
- The pass completes (`finalized`, `passMs=36`).
- `after`: **stableRefs=0**, unstableRefs=1.

The stable reference was held by finalizable garbage, not by the live WebView. This is the controlled experiment the source analysis predicted.

In the two earlier runs, before stall, liveness and exit instrumentation existed, the same control logged `started` but not `finalized` within ~13 s. Those runs cannot tell a blocked pass from a killed control process. The instrumentation now in place (stall snapshot of the pass thread, FinalizerDaemon and ReferenceQueueDaemon; FinalizerWatchdog marker; liveness and exit attribution) will classify any recurrence. Across all runs, the product's identical pass has always completed and the product process has survived.

**The kill path, attributed durably: FD00W (run 39254381137).** During its 8 s observation, the **unmitigated** plain-WebView control, holding the leaked stable ref, was killed. The durable `ApplicationExitInfo.description` classifies the exit as:

- `reason=12 DEPENDENCY DIED`, `subreason=0`
- `provider-death`, `providerClass=gms-fonts`, `dyingProcessClass=gms-persistent`
- `attribution=exit-description`

That is ActivityManager killing a stable FontsProvider client because `com.google.android.gms.persistent`, the process hosting the GMS FontsProvider, died. It is the same Activity (`WebViewBaselineActivity`) and the same reason and subreason as the earlier CS00 blank-WebView death ([39159049059](https://github.com/fatihcayiroglu/Bridge/actions/runs/39159049059)). Why GMS persistent died is not observable from the app and was not investigated: no GMS internals are touched.

Every run is **34 PASS / 1 FAIL / 0 SKIPPED / 16 MEASURED**:

- In runs 39164884625 and 39166491452 the FAIL is FD00G, the uninstrumented stall above.
- In run 39254381137 the FAIL is **FD00W**: the unmitigated control's process was killed by DEPENDENCY DIED. By design, a control whose process vanishes is a FAIL, and it was not relabelled.

Turning these unmitigated, platform-defect controls into non-gating diagnostics (e.g. a nightly job) would change test semantics, so it is left to the owner (§7).

Found and fixed on the way: `parseApplicationExits` read crash exits (`reason=4 (APP CRASH(EXCEPTION))`, `5 (APP CRASH(NATIVE))`) as reason 0, because the nested parenthesis made its regex fall through to `subreason=`. Any earlier "reason 0" process loss in #209 evidence must be re-read with this in mind.

## 5. Hypotheses disproven or narrowed

- **Bridge JS, Capacitor plugins, EmojiCompat or AppCompat start the connection.** Disproven: FD00N/D/S/W connect without any of them; FD00 and FD00P do not. EmojiCompat is not configured (FD01 native probe). The emoji2 initializer was already removed in #316.
- **WebView attachment or a View is required.** Disproven: FD00N, navigated but never attached, connects.
- **`WebView.destroy()` releases the dependency.** Disproven (FD00T). The source shows why: the holder is not the WebView.
- **An unstable FD01 reference is a kill risk.** Disproven by AOSP: only `stableCount() > 0` clients are killed.
- **The FontsProvider reference causes the FocusEvent ANRs (reason 6).** Not supported. In run 39038117703, FD02 saw **zero** references at 1.5, 4 and 8 s on the very PID that later hit the FocusEvent ANR at L01. The ANRs remain a separate, open defect.
- **CS00's death came from the SDK sandbox.** Disproven: subreason 0, and that path writes subreason 27.

**Settled:** FD00W in run 39254381137 is a durably attributed GMS-FontsProvider provider-death kill of an unmitigated WebView control, not a `killPackageDependents` package update and not the SDK sandbox. The earlier CS00 event predates description attribution. It is attributed only by its identical control, reason and subreason, not by its own description.

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

Until that decision, FD01 stays as written. With the mitigation in place, FD01 should now pass for a real reason, since the stable reference is gone. A pass on one run proves nothing permanent.

## 7. Remaining work before #209 can close

1. ~~Show stable → 0 on the same PID with the WebView alive~~ **done** (FD00G, run 39254381137). **Open:** classify any recurrence of the earlier "started but not finalized" stalls with the new instrumentation. If the forced pass is ever seen to wedge or kill a WebView-113 process, the production mitigation must be revisited.
2. Product evidence is consistent across three independent runs (`passes ≥ 1`, 0 stable refs after login, FD01 PASS). Keep collecting runs, and run on physical devices.
3. A **fixed-WebView** image (e.g. API 35, WebView 124) must show no stable reference in FD00W/FD00T without any mitigation, and the mitigation must report `skipped webview-not-affected`.
4. **Physical devices** with current Play-updated WebView, plus one GMS device with a frozen pre-117 WebView if obtainable. No physical-device testing has been done.
5. The **FocusEvent ANRs** (reason 6) need their own main-thread evidence. ANR02 now classifies fatal ANR traces app-locally, but no ANR has recurred since it was added, and it cannot see non-fatal ANRs or exits evicted from Android's 16-record history.
6. Owner decision on the FD01′ contract (§6).
7. **Owner decision:** the unmitigated controls (FD00W, CS00 blank-WebView, FD00T, FD00N/D/S) reproduce a platform defect that Bridge cannot fix in an unmodified WebView. They can turn CI red through a DEPENDENCY DIED kill whenever GMS persistent restarts during their window, as FD00W did in run 39254381137. Decide whether they stay per-PR gates or move to a non-gating nightly diagnostic. Per the project rules, this PR does not change their semantics.
