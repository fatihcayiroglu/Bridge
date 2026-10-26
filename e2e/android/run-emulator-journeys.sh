#!/usr/bin/env bash
# e2e/android/run-emulator-journeys.sh — runs INSIDE the booted emulator step of
# .github/workflows/mobile-android.yml. Installs the debug APK WITHOUT pre-granting runtime
# permissions (the journeys exercise the real Android permission flow), bridges the host Bridge
# server into the emulator (adb reverse) and runs the journeys.
set -euo pipefail

APK="${APK_PATH:?APK_PATH is required}"
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'
# The app's server address is http://localhost:3000 inside the emulator. It is forwarded to a
# proxy owned by the journey runner (ANDROID_PROXY_PORT), which relays to the real server on :3000:
# adb reverse bypasses the emulated radio, so only the proxy can really cut the network path.
export ANDROID_PROXY_PORT="${ANDROID_PROXY_PORT:-3100}"
adb reverse tcp:3000 "tcp:${ANDROID_PROXY_PORT}"
adb install -r "$APK"
adb shell pm list packages com.bridge.app.debug
# Keep the screen awake so lifecycle transitions are driven by the journeys, not by a screen timeout.
adb shell svc power stayon true
adb shell settings put global window_animation_scale 0 || true

cd e2e
set +e
node android/android-journeys.mjs
status=$?
# Calibrate diagnostics only AFTER the product process and evidence are done:
# do not warm startup, alter an ANR window or mix the expected crash into the
# product exit ledger. Both results remain independently visible and gating.
if [[ "${ANDROID_JOURNEY_SUITE:-product}" != "upstream-webview-controls" ]]; then
  node android/java-crash-control.mjs
  control_status=$?
  if [[ "$status" -eq 0 && "$control_status" -ne 0 ]]; then status=$control_status; fi
fi
set -e
# Never archive unfiltered device-wide logs: they can contain user data,
# credentials, intent extras and unrelated app activity. The journey runner
# already records allowlisted, bounded ANR/process/provider summaries when
# those checks execute, preserving exact failures without exporting raw logs.
exit $status
