# Android #490: acknowledged native navigation durability

Two independent exact-head API 34 emulator runs (40340753264, 40351437665)
showed a WebView `localStorage` channel preference that matched the selection
immediately before `am force-stop` holding an older value at the next boot.
EX02 showed the same with page JavaScript paused. Proven: a returned
`setItem()` is not a disk commit. Not proven: the exact Chromium mechanism.
#491 does not depend on it.

## Design

- `BridgeNavigationStorePlugin` (Android only) stores the same user/server
  scoped keys with `SharedPreferences.Editor.commit()` on one process-wide
  background thread. A write is acknowledged only after `commit()` returned
  true. `apply()` is never used as evidence. Main-thread disk work is refused.
- Keys: `bridge:last-navigation:v1:server:<user>` and
  `bridge:last-navigation:v1:channel:<user>:<server>`; values are IDs only.
  User and server segments may not contain `:`, so a key has exactly one
  owner. Bounded lengths, printable ASCII values, at most 4096 entries.
- The client still writes `localStorage` (browser and Electron are unchanged)
  and mirrors each Android selection to the native store through one
  serialized, coalescing queue (`pending` -> `acknowledged` | `failed`).
- One bounded (3 s) native read per page starts when the server rail mounts.
  It repairs a rolled-back WebView value; a selection made during the read
  wins. Only the restore *decision* waits; the rail and channel list render
  first (the `224d7145` ordering delayed the rail and broke P03; fixed in
  `44addee5`).
- Restoration still intersects with the fresh authorized API list: revoked,
  deleted, expired, foreign-server or voice/stage channels are never restored.
  Account erasure removes the account's native entries; a failed removal keeps
  the account in the erasure sweep.
- Evidence: debug-only logcat tag `BridgeNavStore`
  (`requested`/`committed`/`failed`/`boot-read`; kind, sequence, op, ms,
  counts) and `window.__bridgeNavigationDurabilityV1` (counters, states,
  booleans). Neither contains keys, IDs, values or tokens.

## Exact-head evidence (#491, all runs retained)

| Run | Head | Product | EX01 | NAVSTORE |
|---|---|---|---|---|
| 40358574775 | `224d7145` | 36/0/0 | PASS 9/9 | PASS 53/53 |
| 40367496149 | `224d7145` | 32/5/0 (P03 first) | PASS 9/9 | PASS 56/56 |
| 40372179387 | `44addee5` | 36/0/0 | FAIL native focus (storage correct) | PASS 47/47 |
| 40374847182 | `44addee5` | 36/0/0 | PASS 9/9 | PASS 61/61 |

The EX01 focus failure had two `mCurrentFocus` records on display 0. #492
shows from Android 14 source that the full window dump can replay a
last-ANR snapshot (up to 2 h old) ahead of live focus. That is a probe defect
in the #489/#209 workstream, not a storage result. In every run, every EX01
phase that reached the channel check restored the expected channel; the
rollback did not recur. Four runs are not causal closure of an intermittent
defect.

## Physical-device acceptance procedure (not yet performed)

Physical acceptance is **incomplete** until someone runs this procedure and
records the results; emulator runs do not substitute for it.

**Setup**

- Devices: at least one Android 14 and one Android 15 phone, if available
  also Android 12/13. Record model, Android build, and the WebView version
  (`adb shell dumpsys package com.google.android.webview | grep versionName`).
- Build: the exact #491 head as a debug APK (`mobile/BUILD.md`); record the
  SHA. Package `com.bridge.app.debug`.
- Fixture: a test server, two test accounts (A, B), two servers (S1, S2),
  each with at least three text channels and one voice channel.
- Inspect state from Chrome `chrome://inspect` → the app's WebView console:
  `__bridgeNavigationDurabilityV1.inspectChannel(user, server, channel)` and
  `.status()`.
- Evidence after each case: `adb logcat -d -s BridgeNavStore:I '*:S'` and
  `adb logcat -b events -d -s am_anr:I am_crash:I`. Keep raw logs on the
  test machine only; publish counts and PASS/FAIL/MEASURED.

**Cases** (a case is PASS only if every listed expectation holds; record the
first failure and do not retry it away)

1. **Acknowledged force-stop.** As A on S1 select channel 2; wait for
   `inspectChannel` = `acknowledged`; `adb shell am force-stop
   com.bridge.app.debug`; `adb shell am start -W -n
   com.bridge.app.debug/com.bridge.app.MainActivity`. Expect `LaunchState:
   COLD` and channel 2 active.
2. **Background process death.** Select channel 3, wait for the
   acknowledgment, press HOME, `adb shell am kill com.bridge.app.debug`, then
   relaunch from the launcher. Expect a new PID and channel 3 active.
3. **Reboot.** Select channel 2, wait for the acknowledgment, `adb reboot`,
   open the app. Expect channel 2 active.
4. **Rapid selections.** Tap ten different channels quickly, ending on channel
   3; wait for the acknowledgment of channel 3; force-stop; relaunch. Expect
   channel 3; `status().failed` = 0.
5. **Unacknowledged kill (MEASURED, negative control).** Select a new channel
   and force-stop at once, without waiting. Record whether the new or the
   previous channel is restored. Either is allowed, because the selection was
   never acknowledged. A channel from another server or account is a FAIL.
6. **Isolation.** A selects S1/channel 2 and S2/channel 3; sign out; B signs
   in. Expect B's own (or first authorized) channels, never A's. Sign back in
   as A: S1/channel 2 and S2/channel 3 are restored.
7. **Revoked, deleted and voice.** While the app is force-stopped, delete the
   remembered channel (or remove A's access) from another client. Relaunch:
   expect the first authorized text channel and no trace of the removed
   channel. Select a voice channel, force-stop, relaunch: the app must not
   join voice or request the microphone.
8. **Account erasure.** Delete account A from settings. Expect a
   `committed ... op=forget` line in `BridgeNavStore`.
9. **No main-thread stall / ANR.** Across cases 1–8: no ANR dialog, no
   `am_anr` or `am_crash` event for the package.
10. **Privacy.** `BridgeNavStore` lines contain none of the user, server or
    channel IDs used, and no tokens.

**Record** per device: model, Android build, WebView version, APK SHA, each
case result, and the first failing expectation. Do not edit results after the
fact; add a new dated entry instead.

## Status

#490 stays open until repeated exact-head emulator runs and this physical
procedure pass. #209 (FocusEvent ANR) remains a separate open blocker.
#375 is not merged.
