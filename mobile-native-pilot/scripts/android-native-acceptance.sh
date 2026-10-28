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
  (( status == 0 )) || acceptance_print_runtime_errors android < native-evidence/android-logcat.txt
  (( status == 0 )) || acceptance_print_anr_reports android < native-evidence/android-logcat.txt
  if (( status != 0 )) && [[ -f native-evidence/pre-test-logcat.txt ]]; then
    acceptance_print_anr_reports android_boot < native-evidence/pre-test-logcat.txt
  fi
  if (( status != 0 )); then
    acceptance_print_tail native-evidence/first-launch.txt android LAUNCH 20
    acceptance_print_tail native-evidence/metro-android.log android METRO 40
  fi
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
# Keep what happened BEFORE the clear: run 40609188821 showed a launcher ANR dialog from
# the first dump but no ANR report after this clear, i.e. it happened at/after boot.
adb logcat -d > native-evidence/pre-test-logcat.txt 2>&1 || true
adb logcat -c
function assert_native_marker() {
  local marker="$1" output="$2"
  for i in $(seq 1 90); do
    # Dump output kept (was /dev/null) so a failing dump leaves its message behind;
    # pull progress still goes to the job log as before.
    adb shell uiautomator dump /sdcard/native-acceptance.xml >> native-evidence/uiautomator-dump.log 2>&1
    adb pull /sdcard/native-acceptance.xml "$output" >/dev/null
    if grep -q NATIVE_ACCEPTANCE_FAILED "$output"; then
      acceptance_detail="$marker:app-reported-failure"; acceptance_print_ui_text "$output" android; return 1
    fi
    if grep -q 'catalyst_redbox_title\|runtime not ready' "$output"; then
      acceptance_detail="$marker:redbox-or-runtime-not-ready"; acceptance_print_ui_text "$output" android; return 1
    fi
    if grep -q "$marker" "$output"; then return 0; fi
    sleep 2
  done
  acceptance_detail="$marker:not-seen-in-90-dumps"
  acceptance_print_ui_text "$output" android
  return 1
}
# Recorded, NOT asserted: is Metro reachable from INSIDE the device through the reverse
# tunnel right before launch? The app's own startup check (RN PackagerStatusCheck, 5 s
# connect timeout) failing makes it load from assets -> "Unable to load script" redbox
# (run 40608904348). This shows whether the tunnel or the device was the problem.
stage=pre-launch-metro-probe
{
  echo "reverse_list: $(adb reverse --list 2>&1 | tr '\n' ' ' || true)"
  # Monotonic (uptime), not wall clock: CI's wall clock stepped back mid-probe (-355 ms).
  probe_start=$(awk '{ printf "%d", $1 * 1000 }' /proc/uptime)
  probe_out=$(adb shell 'printf "GET /status HTTP/1.0\r\n\r\n" | toybox nc -w 5 127.0.0.1 8081' 2>&1 || true)
  echo "device_status_ms=$(( $(awk '{ printf "%d", $1 * 1000 }' /proc/uptime) - probe_start ))"
  echo "device_status_body: $(printf '%s' "$probe_out" | tail -n 1)"
  # The app itself uses RN's emulator host alias 10.0.2.2 (log: "Loading from 10.0.2.2:8081"),
  # i.e. the emulator NAT, not the reverse tunnel; probe that path too.
  probe_start=$(awk '{ printf "%d", $1 * 1000 }' /proc/uptime)
  probe_out=$(adb shell 'printf "GET /status HTTP/1.0\r\n\r\n" | toybox nc -w 5 10.0.2.2 8081' 2>&1 || true)
  echo "emulator_host_status_ms=$(( $(awk '{ printf "%d", $1 * 1000 }' /proc/uptime) - probe_start ))"
  echo "emulator_host_status_body: $(printf '%s' "$probe_out" | tail -n 1)"
} > native-evidence/pre-launch-metro.txt 2>&1 || true
acceptance_print_tail native-evidence/pre-launch-metro.txt android PRELAUNCH 6
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
# Run 40609216285 (#535, 8d651642) passed both marker stages, then `adb logcat -d` exited
# 255 here with no stderr, and the cleanup's own capture was empty too. The log is
# evidence (and #535's pilot-ANR check reads it), so a failed capture still FAILS the run,
# but now says why: exit code, stderr, bytes read, logd state, buffer sizes.
logcat_status=0
adb logcat -d > native-evidence/android-logcat.txt 2> native-evidence/logcat-stderr.txt || logcat_status=$?
if (( logcat_status != 0 )); then
  {
    echo "exit=$logcat_status bytes=$(wc -c < native-evidence/android-logcat.txt)"
    echo "stderr: $(tr '\n' ' ' < native-evidence/logcat-stderr.txt)"
    echo "logd: $(adb shell getprop init.svc.logd 2>&1 | tr '\n' ' ' || true)"
    echo "buffers: $(adb logcat -g 2>&1 | tr '\n' ' ' || true)"
  } > native-evidence/logcat-failure.txt 2>&1 || true
  acceptance_print_tail native-evidence/logcat-failure.txt android LOGCAT 8
  acceptance_detail="logcat-capture-failed:exit=$logcat_status"
  false
fi
stage=verdict
echo 'NATIVE_ANDROID_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS' | tee native-evidence/native-verdict.txt
# am start timing above is a debug/Metro diagnostic, NOT release TTID/TTFD or
# proof of <1s/<2s meaningful UI targets. Never relabel these as performance PASS.
