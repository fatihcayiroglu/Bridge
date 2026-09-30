#!/usr/bin/env bash
# e2e/android/run-emulator-journeys.sh — runs INSIDE the booted emulator step of
# .github/workflows/mobile-android.yml. Installs the debug APK WITHOUT pre-granting runtime
# permissions (the journeys exercise the real Android permission flow), bridges the host Bridge
# server into the emulator (adb reverse) and runs the journeys.
set -euo pipefail

APK="${APK_PATH:?APK_PATH is required}"
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'
adb reverse tcp:3000 tcp:3000
adb install -r "$APK"
adb shell pm list packages com.bridge.app.debug
# Keep the screen awake so lifecycle transitions are driven by the journeys, not by a screen timeout.
adb shell svc power stayon true
adb shell settings put global window_animation_scale 0 || true

cd e2e
set +e
node android/android-journeys.mjs
status=$?
set -e
adb logcat -d -v time > android/results/logcat.txt 2>/dev/null || true
exit $status
