#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" = 1
test "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" = 35
# Refuse to replace an existing installation or touch its data.
test -z "$(adb shell pm path com.bridge.nativepilot | tr -d '\r')"
adb install mobile-native-pilot/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
adb reverse tcp:8443 tcp:8443
(cd mobile-native-pilot && npx expo start --localhost --port 8081) > "$RUNNER_TEMP/android-auth-metro.log" 2>&1 &
task_metro_pid=$!
cleanup() { local status=$?; kill "$task_metro_pid" 2>/dev/null || true; return "$status"; }
trap cleanup EXIT
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8081/status > /dev/null && break; kill -0 "$task_metro_pid"; sleep 1; done
curl -fsS http://127.0.0.1:8081/status
(cd mobile-native-pilot && node scripts/android-metro-route.mjs)
cp mobile-native-pilot/native-evidence/metro-route.json "$MOBILE_AUTH_EVIDENCE/metro-route.json"
curl -fsS --max-time 180 'http://127.0.0.1:8081/index.bundle?platform=android&dev=true&minify=false' -o /dev/null
node mobile-native-pilot/scripts/android-browser-auth.mjs
node --input-type=module -e 'import fs from "node:fs";const r=JSON.parse(fs.readFileSync(process.env.MOBILE_AUTH_EVIDENCE+"/android-browser-auth.json"));if(r.status!=="PASS"||r.cases.length!==3||r.cases.some(c=>c.status!=="PASS")||r.notExecuted.length)throw Error("ANDROID_AUTH_INCOMPLETE");console.log(JSON.stringify({tests:3,passed:3,failed:0,notExecuted:0,skipped:0}));'
