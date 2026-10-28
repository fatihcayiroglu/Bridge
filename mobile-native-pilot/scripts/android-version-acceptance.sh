#!/usr/bin/env bash
set -euo pipefail
api="$1"
adb shell getprop ro.build.version.sdk | tr -d '\r' > mobile-native-pilot/native-evidence/runtime-api.txt
test "$(cat mobile-native-pilot/native-evidence/runtime-api.txt)" = "$api"
status=0
bash mobile-native-pilot/scripts/android-native-acceptance.sh || status=$?
(cd mobile-native-pilot && node scripts/native-version-evidence.mjs record-android "$api" "$status")
exit "$status"
