#!/usr/bin/env bash
set -euo pipefail
udid="$1"
function assert_native_marker() {
  local marker="$1" output="$2"
  for i in $(seq 1 30); do
    xcrun simctl io "$udid" screenshot "native-evidence/$output.png"
    native-evidence/read-native-screen "native-evidence/$output.png" > "native-evidence/$output.txt"
    if grep -q NATIVE_ACCEPTANCE_FAILED "native-evidence/$output.txt"; then return 1; fi
    if grep -q "$marker" "native-evidence/$output.txt"; then return 0; fi
    sleep 3
  done
  return 1
}
xcrun swiftc scripts/native-screenshot-text.swift -o native-evidence/read-native-screen
xcrun simctl launch "$udid" com.bridge.nativepilot | tee native-evidence/simulator-launch.txt
assert_native_marker NATIVE_SQLCIPHER_WRITE_PASS first-native-ui
grep -q NATIVE_SECURE_STORE_ROUNDTRIP_PASS native-evidence/first-native-ui.txt
grep -q NATIVE_ACCOUNT_ISOLATION_PASS native-evidence/first-native-ui.txt
xcrun simctl terminate "$udid" com.bridge.nativepilot
xcrun simctl launch "$udid" com.bridge.nativepilot | tee native-evidence/simulator-restart.txt
assert_native_marker NATIVE_SQLCIPHER_RECOVERY_PASS restart-native-ui
grep -q NATIVE_SECURE_STORE_RESTORE_PASS native-evidence/restart-native-ui.txt
grep -q NATIVE_ACCOUNT_ISOLATION_PASS native-evidence/restart-native-ui.txt
echo 'NATIVE_IOS_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS' | tee native-evidence/native-verdict.txt
