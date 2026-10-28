#!/usr/bin/env bash
# A real, signed-out RN app smoke across four logical display overrides.
# Never call these exact physical 6.2/6.5-inch emulator hardware tests.
set -euo pipefail
cd mobile-native-pilot
mkdir -p native-evidence/layout-android
report=native-evidence/layout-android/results.json
node scripts/layout-profiles.mjs init android "$report"
node scripts/layout-profiles.mjs android-tsv > native-evidence/layout-android/profiles.tsv
active_profile=''
stage=prerequisites
metro_pid=''
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    echo "NATIVE_ANDROID_LAYOUT_FIRST_FAILURE profile=${active_profile:-none} stage=$stage exit=$status" >&2
    if [[ -n "$active_profile" ]]; then
      node scripts/layout-profiles.mjs set "$report" "$active_profile" FAIL "$stage" || true
    fi
    adb logcat -d > native-evidence/layout-android/failure-logcat.txt 2>&1 || true
    adb shell screencap -p /sdcard/bridge-layout-last.png >/dev/null 2>&1 &&
      adb pull /sdcard/bridge-layout-last.png native-evidence/layout-android/failure.png >/dev/null 2>&1 || true
  fi
  # These commands only affect the disposable CI emulator. Restore its display.
  adb shell wm size reset >/dev/null 2>&1 || true
  adb shell wm density reset >/dev/null 2>&1 || true
  if [[ -n "$metro_pid" ]]; then kill "$metro_pid" 2>/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT

[[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || { echo 'EMULATOR_REQUIRED'; exit 1; }
stage=metro-start
npx expo start --localhost --port 8081 > native-evidence/layout-android/metro.log 2>&1 &
metro_pid=$!
stage=metro-ready
ready=0
for _ in $(seq 1 60); do
  kill -0 "$metro_pid"
  if curl --fail --silent --max-time 4 http://127.0.0.1:8081/status | grep -q '^packager-status:running$'; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'METRO_NOT_READY'; exit 1; }
stage=apk-install
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081

# Keep profile input on fd 3: adb may read fd 0 and would silently consume
# the remaining lines, leaving a 1/4 result that rightly fails the gate.
while IFS=$'\t' read -r -u 3 id width height dpi; do
  active_profile="$id"
  mkdir -p "native-evidence/layout-android/$id"
  output="native-evidence/layout-android/$id"
  stage="${id}-viewport"
  adb shell wm size "${width}x${height}"
  adb shell wm density "$dpi"
  adb shell wm size > "$output/display-size.txt"
  adb shell wm density > "$output/display-density.txt"
  grep -F "Override size: ${width}x${height}" "$output/display-size.txt"
  grep -F "Override density: $dpi" "$output/display-density.txt"

  stage="${id}-clean-fixture"
  adb shell am force-stop com.bridge.nativepilot || true
  adb shell pm clear com.bridge.nativepilot
  node scripts/android-metro-route.mjs > "$output/metro-route.log" 2>&1
  stage="${id}-launch"
  adb shell am start -W -n com.bridge.nativepilot/.MainActivity > "$output/launch.txt"
  stage="${id}-rendered-ui"
  found=0
  for attempt in $(seq 1 36); do
    if adb shell uiautomator dump /sdcard/bridge-layout-ui.xml >> "$output/uiautomator.log" 2>&1 &&
       adb pull /sdcard/bridge-layout-ui.xml "$output/last-ui.xml" >> "$output/uiautomator.log" 2>&1; then
      if node scripts/layout-profiles.mjs verify-android "$output/last-ui.xml" "$width" "$height" > "$output/ui-verdict.txt" 2>&1; then
        found=1; break
      fi
      # A real app redbox is a failure, not an opportunity to poll it away.
      if grep -Eq 'catalyst_redbox_title|runtime not ready|Unable to load script|NATIVE_ACCEPTANCE_FAILED' "$output/last-ui.xml"; then
        echo "NATIVE_ANDROID_LAYOUT_RUNTIME_ERROR $id" >&2; exit 1
      fi
    fi
    sleep 2
  done
  if [[ "$found" != 1 ]]; then
    echo "NATIVE_ANDROID_LAYOUT_ASSERTION_FAILED $id" >&2
    tail -n 20 "$output/ui-verdict.txt" >&2 || true
    exit 1
  fi
  stage="${id}-screenshot"
  adb shell screencap -p /sdcard/bridge-layout-last.png
  adb pull /sdcard/bridge-layout-last.png "$output/screen.png"
  test -s "$output/screen.png"
  node scripts/layout-profiles.mjs set "$report" "$id" PASS
  echo "NATIVE_ANDROID_LAYOUT $id PASS viewport=${width}x${height}@${dpi}dpi"
  active_profile=''
done 3< native-evidence/layout-android/profiles.tsv
stage=complete-gate
node scripts/layout-profiles.mjs assert-complete "$report"
echo 'NATIVE_ANDROID_SIGNED_OUT_LAYOUT_MATRIX=PASS'
