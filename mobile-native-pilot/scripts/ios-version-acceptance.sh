#!/usr/bin/env bash
set -euo pipefail
test -d "$IOS_APP_PATH"
export IOS_BINARY_PATH="$IOS_APP_PATH/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$IOS_APP_PATH/Info.plist")"
test -s "$IOS_BINARY_PATH"
/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$IOS_APP_PATH/Info.plist" > native-evidence/ios-deployment-target.txt
node scripts/native-version-evidence.mjs ios-plan > "$RUNNER_TEMP/bridge-ios-runtime-plan.txt"
failed=0
while IFS='|' read -r runtime version; do
  evidence="native-evidence/ios-${version//./-}"
  mkdir -p "$evidence"
  # Each runtime gets a fresh, owned simulator, preserving all other app data.
  udid=$(xcrun simctl create "Bridge P7 ${GITHUB_RUN_ID}-${version}" com.apple.CoreSimulator.SimDeviceType.iPhone-14 "$runtime")
  printf '%s\n' "$udid" > "$evidence/simulator-udid.txt"
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl list -j > "$evidence/booted-device.json"
  node scripts/native-version-evidence.mjs ios-observed "$evidence" "$udid"
  xcrun simctl install "$udid" "$IOS_APP_PATH" 2>&1 | tee "$evidence/install.txt"
  status=0
  NATIVE_EVIDENCE_DIR="$evidence" bash scripts/ios-native-acceptance.sh "$udid" || status=$?
  # First failure is retained. A later independent OS sample never replaces it.
  xcrun simctl spawn "$udid" log show --last 3m --style compact --predicate 'process == "BridgeNativePilot" OR process == "SpringBoard" OR process == "securityd"' > "$evidence/app-runtime.log" || true
  xcrun simctl io "$udid" screenshot "$evidence/final-screen.png" || true
  node scripts/native-version-evidence.mjs record-ios "$version" "$status" "$evidence" || failed=1
  xcrun simctl shutdown "$udid"
done < "$RUNNER_TEMP/bridge-ios-runtime-plan.txt"
exit "$failed"
