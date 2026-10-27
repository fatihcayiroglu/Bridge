#!/usr/bin/env bash
set -euo pipefail
udid="$1"
app="${2:?usage: ios-native-acceptance.sh UDID APP_PATH}"
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
grep -q NATIVE_RECEIPT_COMPACTION_PASS native-evidence/first-native-ui.txt
grep -q NATIVE_INSTALL_GUARD_FRESH native-evidence/first-native-ui.txt
xcrun simctl terminate "$udid" com.bridge.nativepilot
xcrun simctl launch "$udid" com.bridge.nativepilot | tee native-evidence/simulator-restart.txt
assert_native_marker NATIVE_SQLCIPHER_RECOVERY_PASS restart-native-ui
grep -q NATIVE_SECURE_STORE_RESTORE_PASS native-evidence/restart-native-ui.txt
grep -q NATIVE_ACCOUNT_ISOLATION_PASS native-evidence/restart-native-ui.txt
grep -q NATIVE_RECEIPT_COMPACTION_RESTORE_PASS native-evidence/restart-native-ui.txt
grep -q NATIVE_INSTALL_GUARD_KEPT native-evidence/restart-native-ui.txt
grep -q NATIVE_INSTALL_LEFTOVER_NONE native-evidence/restart-native-ui.txt
# Uninstall and reinstall: the sandbox (journals, install marker) is deleted; the Keychain
# may not be. The app must start as a fresh installation with an empty credential slot
# (the probe fails INSTALL_GUARD_CREDENTIAL_MISMATCH otherwise) and redo first-launch work.
xcrun simctl terminate "$udid" com.bridge.nativepilot
xcrun simctl uninstall "$udid" com.bridge.nativepilot
xcrun simctl install "$udid" "$app" | tee native-evidence/simulator-reinstall.txt
xcrun simctl launch "$udid" com.bridge.nativepilot | tee native-evidence/simulator-reinstall-launch.txt
assert_native_marker NATIVE_INSTALL_GUARD_FRESH reinstall-native-ui
grep -q NATIVE_SQLCIPHER_WRITE_PASS native-evidence/reinstall-native-ui.txt
grep -q NATIVE_SECURE_STORE_ROUNDTRIP_PASS native-evidence/reinstall-native-ui.txt
grep -q NATIVE_RECEIPT_COMPACTION_PASS native-evidence/reinstall-native-ui.txt
# Whether THIS simulator kept the Keychain item over uninstall is recorded, not asserted:
# it is a property of the platform build, and a simulator is not a device.
if grep -q NATIVE_INSTALL_LEFTOVER_PURGED native-evidence/reinstall-native-ui.txt; then leftover=found-and-purged
elif grep -q NATIVE_INSTALL_LEFTOVER_NONE native-evidence/reinstall-native-ui.txt; then leftover=absent
else leftover=unreadable; fi
echo "NATIVE_IOS_SIMULATOR_KEYCHAIN_AFTER_UNINSTALL=$leftover" | tee native-evidence/ios-reinstall-keychain.txt
[[ "$leftover" != unreadable ]]
echo 'NATIVE_IOS_SECURE_STORE_SQLCIPHER_RESTART_AND_REINSTALL=PASS' | tee native-evidence/native-verdict.txt
