#!/usr/bin/env bash
set -euo pipefail
cd mobile-native-pilot
mkdir -p native-evidence
# shellcheck source=acceptance-failure-trap.sh
source scripts/acceptance-failure-trap.sh
stage=metro-start
node -e 'require("dns").lookup("localhost", (error,address,family)=>{if(error)throw error; console.log({address,family})})' > native-evidence/metro-dns.txt
npx expo start --localhost --port 8081 > native-evidence/metro-android.log 2>&1 &
metro_pid=$!
function cleanup() {
  local status=$?
  acceptance_record_failure "$status" native-evidence android
  adb logcat -d > native-evidence/android-logcat.txt 2>&1 || true
  adb shell screencap -p /sdcard/native-failure.png >/dev/null 2>&1 && adb pull /sdcard/native-failure.png native-evidence/final-screen.png >/dev/null 2>&1 || true
  kill "$metro_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
stage=metro-ready
for i in $(seq 1 60); do
  kill -0 "$metro_pid" || { cat native-evidence/metro-android.log; exit 1; }
  if curl -fsS http://127.0.0.1:8081/status >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8081/status
stage=adb-reverse
adb reverse tcp:8081 tcp:8081
stage=apk-install
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
stage=fixture-reset
adb shell pm clear com.bridge.nativepilot
adb logcat -c
function assert_native_marker() {
  local marker="$1" output="$2"
  for i in $(seq 1 90); do
    # Dump output kept (was /dev/null) so a failing dump leaves its message behind;
    # pull progress still goes to the job log as before.
    adb shell uiautomator dump /sdcard/native-acceptance.xml >> native-evidence/uiautomator-dump.log 2>&1
    adb pull /sdcard/native-acceptance.xml "$output" >/dev/null
    if grep -q NATIVE_ACCEPTANCE_FAILED "$output"; then acceptance_detail="$marker:app-reported-failure"; return 1; fi
    if grep -q 'catalyst_redbox_title\|runtime not ready' "$output"; then acceptance_detail="$marker:redbox-or-runtime-not-ready"; return 1; fi
    if grep -q "$marker" "$output"; then return 0; fi
    sleep 2
  done
  acceptance_detail="$marker:not-seen-in-90-dumps"
  return 1
}
stage=first-launch
adb shell am start -W -n com.bridge.nativepilot/.MainActivity > native-evidence/first-launch.txt
stage=first-ui-assertions
assert_native_marker NATIVE_SQLCIPHER_WRITE_PASS native-evidence/first-ui.xml
grep -q NATIVE_SECURE_STORE_ROUNDTRIP_PASS native-evidence/first-ui.xml
grep -q NATIVE_RECEIPT_COMPACTION_PASS native-evidence/first-ui.xml
stage=force-stop
adb shell am force-stop com.bridge.nativepilot
stage=restart-launch
adb shell am start -W -n com.bridge.nativepilot/.MainActivity > native-evidence/restart-launch.txt
stage=restart-ui-assertions
assert_native_marker NATIVE_SQLCIPHER_RECOVERY_PASS native-evidence/restart-ui.xml
grep -q NATIVE_SECURE_STORE_RESTORE_PASS native-evidence/restart-ui.xml
grep -q NATIVE_ACCOUNT_ISOLATION_PASS native-evidence/restart-ui.xml
grep -q NATIVE_RECEIPT_COMPACTION_RESTORE_PASS native-evidence/restart-ui.xml
stage=final-screenshot-capture
adb shell screencap -p /sdcard/native-acceptance.png
stage=final-screenshot-pull
adb pull /sdcard/native-acceptance.png native-evidence/android.png
stage=final-logcat
adb logcat -d > native-evidence/android-logcat.txt
stage=verdict
echo 'NATIVE_ANDROID_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS' | tee native-evidence/native-verdict.txt
# am start timing above is a debug/Metro diagnostic, NOT release TTID/TTFD or
# proof of <1s/<2s meaningful UI targets. Never relabel these as performance PASS.
