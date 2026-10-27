# Android #209: physical-device startup and lifecycle procedure

**Status: not yet performed.** No physical device has been available to the
work on #493/#494/#495. Emulator results (API 34, `swiftshader_indirect`
software GL) do **not** substitute for this procedure, and #209 stays open
until it has been run on real hardware and recorded below.

The emulator evidence it has to confirm or refute (#493, #495):

- Bridge's first frame in a fresh process blocks the main thread in graphics
  `frame-sync` for 3–6 s (probe `before-displayed` / `displayed-to-attached`
  phases); a bare WebView's first frame costs under 0.4 s.
- One such stall over 5 s produced the FocusEvent input-dispatch ANR (CS01,
  runs 40425507186 and 40460571063).
- With #494's gradients, warm renders and the steady state have no stalls of
  250 ms or more.

The open question is how much of that first-frame cost exists on a
hardware-accelerated GPU.

## Setup

- **Devices:** at least one low-end and one mid/high-end phone, Android 12–15
  if available. Record model, SoC/GPU, Android build and WebView version
  (`adb shell dumpsys package com.google.android.webview | grep versionName`).
- **Builds:** debug APKs of the exact heads under test, at minimum #495 (the
  integration candidate) and #493 (blur, the negative control for #494).
  Record each SHA. Package `com.bridge.app.debug`. The debug build contains
  the stall probe (`BridgeStallProbe`); release does not.
- **Fixture:** a test server and the accounts and servers from the #490
  procedure (`docs/P7_ANDROID_NATIVE_NAVIGATION_DURABILITY_20261026.md`).
- **Evidence:** keep raw logs on the test machine only. Publish counts,
  timings and PASS/FAIL/MEASURED, never IDs, tokens or message text.

```sh
P=com.bridge.app.debug
stalls() { adb logcat -d -v brief --pid "$1" -s BridgeStallProbe:I '*:S'; }
skips()  { adb logcat -d -v brief --pid "$1" -s Choreographer:I '*:S'; }
anrs()   { adb logcat -b events -d -s am_anr:I am_crash:I | grep -c "$P"; }
```

## Cases

A case is PASS only if every expectation holds. Record the first failure and
do not retry it away. MEASURED cases are evidence, never counted as PASS.

1. **Cold start ×10 (MEASURED).** For each: `adb logcat -c`;
   `adb shell am force-stop $P`; `adb shell am start -W -n
   $P/com.bridge.app.MainActivity` (record `TotalTime`); wait 10 s;
   `PID=$(adb shell pidof $P)`; record `stalls $PID` (count, max `ms`,
   `where`) and `skips $PID` (max frames). Compare with SF01/SF02.
2. **No cold-start ANR (PASS/FAIL).** Across case 1, `anrs` stays 0, no "isn't
   responding" dialog appears, and during each cold start a tap on the
   screen within 2 s of launch is handled (input is not blocked for 5 s).
3. **Warm start and hot resume (PASS/FAIL).** HOME, wait 20 s, reopen from
   recents: same PID, the selected channel is still active, no ANR. Repeat
   with 75 s (socket idle). Matches L01/L02.
4. **Force-stop and process death (PASS/FAIL).** Run the #490 procedure's
   cases 1–4. They must pass on the integration build (#495).
5. **Deep links (PASS/FAIL).** Cold and warm `adb shell am start -W -a
   android.intent.action.VIEW -d "bridge://channel/<id>"` opens that
   channel; a channel the user cannot access does not open (DL01–DL04).
6. **Voice and video (PASS/FAIL).** Join a voice channel with a second
   account; audio flows both ways; enable the camera; background the app for
   60 s (MEASURED: does capture continue?); leave and confirm the media
   connections close (P03, P04, P07, V03).
7. **Permissions (PASS/FAIL).** Deny and then grant microphone, camera and
   notifications in the real system sheets: the app explains the denial and
   works after the grant, without crashing (P01, P02, P05, P06).
8. **Memory pressure (MEASURED + PASS/FAIL).** With a channel open:
   `adb shell am send-trim-memory $P RUNNING_CRITICAL`, then background and
   `adb shell am send-trim-memory $P COMPLETE`. Record PSS before and after
   (`adb shell dumpsys meminfo $P | grep TOTAL`). After reopening, the session
   and channel are restored (PASS/FAIL).
9. **Background battery behaviour (MEASURED).** `adb shell dumpsys
   batterystats --reset`; background the app for 30 min with the screen off;
   record `adb shell dumpsys batterystats $P` wakelocks, alarms and network
   use. No partial wakelock held for the whole period (PASS/FAIL).
10. **Release-like build (MEASURED).** Repeat case 1 on a release build without
    the probe, recording `TotalTime` and Choreographer skips only, to bound
    the probe's own overhead.

## Record

Per device and build: model, SoC/GPU, Android build, WebView version, APK
SHA, the result of every case, and the first failing expectation. Add new
dated entries; never edit results after the fact.

(no entries yet)
