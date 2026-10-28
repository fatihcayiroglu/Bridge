#!/usr/bin/env bash
set -euo pipefail
udid="$1"
evidence="${NATIVE_EVIDENCE_DIR:-native-evidence}"
mkdir -p "$evidence"
function assert_native_marker() {
  local marker="$1" output="$2"
  for i in $(seq 1 30); do
    xcrun simctl io "$udid" screenshot "$evidence/$output.png"
    "$evidence/read-native-screen" "$evidence/$output.png" > "$evidence/$output.txt"
    if grep -q NATIVE_ACCEPTANCE_FAILED "$evidence/$output.txt"; then return 1; fi
    if grep -q "$marker" "$evidence/$output.txt"; then return 0; fi
    sleep 3
  done
  return 1
}
xcrun swiftc scripts/native-screenshot-text.swift -o "$evidence/read-native-screen"
xcrun simctl launch "$udid" com.bridge.nativepilot | tee "$evidence/simulator-launch.txt"
assert_native_marker NATIVE_SQLCIPHER_WRITE_PASS first-native-ui
grep -q NATIVE_SECURE_STORE_ROUNDTRIP_PASS "$evidence/first-native-ui.txt"
grep -q NATIVE_ACCOUNT_ISOLATION_PASS "$evidence/first-native-ui.txt"
grep -q NATIVE_RECEIPT_COMPACTION_PASS "$evidence/first-native-ui.txt"
xcrun simctl terminate "$udid" com.bridge.nativepilot
xcrun simctl launch "$udid" com.bridge.nativepilot | tee "$evidence/simulator-restart.txt"
assert_native_marker NATIVE_SQLCIPHER_RECOVERY_PASS restart-native-ui
grep -q NATIVE_SECURE_STORE_RESTORE_PASS "$evidence/restart-native-ui.txt"
grep -q NATIVE_ACCOUNT_ISOLATION_PASS "$evidence/restart-native-ui.txt"
grep -q NATIVE_RECEIPT_COMPACTION_RESTORE_PASS "$evidence/restart-native-ui.txt"
echo 'NATIVE_IOS_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS' | tee "$evidence/native-verdict.txt"
