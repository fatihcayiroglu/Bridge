#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$MOBILE_AUTH_EVIDENCE"
export APPIUM_HOME="$PWD/e2e/ios"
e2e/ios/node_modules/.bin/appium driver list --installed
task_appium_log="$RUNNER_TEMP/bridge-native-auth-appium.log"
task_appium_debug="$RUNNER_TEMP/bridge-native-auth-appium-debug.log"
env -u BRIDGE_MOBILE_PASSWORD -u JWT_SECRET -u REFRESH_SECRET -u DATABASE_URL -u IT_TLS_KEY -u BRIDGE_EMULATOR_PIN \
  e2e/ios/node_modules/.bin/appium --address 127.0.0.1 --port 4723 --use-drivers xcuitest --log-level warn:debug --log "$task_appium_debug" --log-no-colors > "$task_appium_log" 2>&1 &
task_appium_pid=$!
cleanup() {
  local task_status=$?
  kill "$task_appium_pid" 2>/dev/null || true
  # Raw WDA traffic and command arguments are never uploaded.
  if test "$task_status" -ne 0; then
    printf 'APPIUM_JOURNEY_EXIT=%s\n' "$task_status" > "$MOBILE_AUTH_EVIDENCE/driver-exit.txt"
    # The phase gate proves no UI command has entered credentials. Later raw
    # traffic can contain them and must NEVER be copied into an artifact.
    if node --input-type=module -e 'import fs from "node:fs";const r=JSON.parse(fs.readFileSync(process.env.MOBILE_AUTH_EVIDENCE+"/ios-browser-auth.json"));process.exit(r.stage==="native-xcuitest-session"&&r.cases.length===0?0:1)'; then
      test ! -f "$task_appium_debug" || cp "$task_appium_debug" "$MOBILE_AUTH_EVIDENCE/appium-before-input.log"
    fi
  fi
  return "$task_status"
}
trap cleanup EXIT
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4723/status > /dev/null && break
  kill -0 "$task_appium_pid"
  sleep 1
done
curl -fsS http://127.0.0.1:4723/status > /dev/null
node mobile-native-pilot/scripts/ios-browser-auth.mjs
node --input-type=module -e '
import fs from "node:fs";
const r=JSON.parse(fs.readFileSync(process.env.MOBILE_AUTH_EVIDENCE+"/ios-browser-auth.json","utf8"));
if(r.status!=="PASS" || r.cases.length!==3 || r.notExecuted.length || r.cases.some(c=>c.status!=="PASS"))throw Error("IOS_MOBILE_AUTH_INCOMPLETE");
console.log(JSON.stringify({cases:3,passed:3,failed:0,notExecuted:0,skipped:0}));'
