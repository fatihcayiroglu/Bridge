#!/usr/bin/env bash
# AUTOMATED / SIMULATOR evidence only. Every prerequisite and assertion gates the job.
set -euo pipefail
export IOS_EVIDENCE_DIR="${IOS_EVIDENCE_DIR:-e2e/ios/results}"
mkdir -p "$IOS_EVIDENCE_DIR"
export IOS_APP_PATH="${IOS_APP_PATH:-$(find build/Build/Products/Debug-iphonesimulator -maxdepth 1 -name '*.app' -print -quit)}"
test -d "$IOS_APP_PATH"
# Assert the built app's existing Debug setting, rather than silently enabling
# release inspection or accepting an uninspectable build as journey evidence.
test "$(/usr/libexec/PlistBuddy -c 'Print :CAPACITOR_DEBUG' "$IOS_APP_PATH/Info.plist")" = true
export IOS_SIMULATOR_UDID="${IOS_SIMULATOR_UDID:-$(xcrun simctl list devices available -j | python3 -c '
import json,sys
devices=json.load(sys.stdin)["devices"]
candidates=[(runtime,device) for runtime,group in devices.items() if "iOS" in runtime for device in group if device["name"].startswith("iPhone")]
candidates.sort(key=lambda item: item[0])
print(candidates[-1][1]["udid"] if candidates else "")')}"
test -n "$IOS_SIMULATOR_UDID"
export IOS_PLATFORM_VERSION="$(xcrun simctl list -j | python3 -c '
import json,sys,os
info=json.load(sys.stdin)
runtime=next(runtime for runtime,group in info["devices"].items() for device in group if device["udid"]==os.environ["IOS_SIMULATOR_UDID"])
print(next(item["version"] for item in info["runtimes"] if item["identifier"]==runtime))')"
test -n "$IOS_PLATFORM_VERSION"
state=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,os
print(next(device["state"] for group in json.load(sys.stdin)["devices"].values() for device in group if device["udid"]==os.environ["IOS_SIMULATOR_UDID"]))')
if [ "$state" != Booted ]; then xcrun simctl boot "$IOS_SIMULATOR_UDID"; fi
xcrun simctl bootstatus "$IOS_SIMULATOR_UDID" -b
# Appium discovers ONLY the pinned driver in this audited dependency directory.
export APPIUM_HOME="$PWD/e2e/ios"
e2e/ios/node_modules/.bin/appium driver list --installed
# Raw debug traffic stays outside uploaded artifacts: it can include WebDriver
# arguments. Preserve only the inspector's application-discovery metadata.
appium_raw=$(mktemp "${RUNNER_TEMP:-/tmp}/bridge-ios-appium.XXXXXX")
e2e/ios/node_modules/.bin/appium --address 127.0.0.1 --port 4723 --use-drivers xcuitest --log-level debug --log-no-colors \
  > "$appium_raw" 2>&1 &
appium_pid=$!
cleanup_appium() {
  local appium_alive=false
  if kill -0 "$appium_pid" 2>/dev/null; then appium_alive=true; fi
  kill "$appium_pid" 2>/dev/null || true
  # No scripts, command arguments, page titles, URLs or console payloads.
  awk '/RemoteDebugger/ && /Remote Debugger version|Connecting to remote debugger|Received connected applications list|Found app id key|Current applications available|Application:|bundleId:|isActive:|isProxy:|No matching|No applications|Empty page dictionary|Notified that new application/ { print substr($0,1,800); count++; if(count>=100) exit }' \
    "$appium_raw" > "$IOS_EVIDENCE_DIR/appium-discovery.log"
  node e2e/ios/appium-startup-evidence.mjs "$appium_raw" "$IOS_EVIDENCE_DIR/appium-startup.json" "$appium_alive"
  rm -f "$appium_raw"
}
trap cleanup_appium EXIT
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:4723/status >/dev/null && break
  kill -0 "$appium_pid"
  sleep 1
done
curl -sf http://127.0.0.1:4723/status >/dev/null
node e2e/ios/expiry-journey.mjs
node -e '
  const fs=require("node:fs");
  const result=JSON.parse(fs.readFileSync(process.env.IOS_EVIDENCE_DIR+"/expiry-journey.json"));
  if(result.id!=="D2L01-iOS" || result.status!=="PASS") process.exit(1);
  const link=JSON.parse(fs.readFileSync(process.env.IOS_EVIDENCE_DIR+"/open-confirmation-journey.json"));
  if(link.id!=="I07-XCUITest" || link.status!=="PASS") process.exit(1);
  const summary="I07-XCUITest: PASS — native OS confirmation accepted, actual channel opened in the same HOT process (AUTOMATED / SIMULATOR).\nD2L01-iOS: PASS — native background/resume, encrypted history/draft purge, permanent-channel control (AUTOMATED / SIMULATOR).\n";
  if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
'
