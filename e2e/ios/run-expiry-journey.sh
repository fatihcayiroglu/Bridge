#!/usr/bin/env bash
# AUTOMATED / SIMULATOR evidence only. Every prerequisite and assertion gates the job.
set -euo pipefail
export IOS_EVIDENCE_DIR="${IOS_EVIDENCE_DIR:-e2e/ios/results}"
mkdir -p "$IOS_EVIDENCE_DIR"
export IOS_APP_PATH="${IOS_APP_PATH:-$(find build/Build/Products/Debug-iphonesimulator -maxdepth 1 -name '*.app' -print -quit)}"
test -d "$IOS_APP_PATH"
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
e2e/ios/node_modules/.bin/appium --address 127.0.0.1 --port 4723 --use-drivers xcuitest --log-level warn \
  > "$IOS_EVIDENCE_DIR/appium.log" 2>&1 &
appium_pid=$!
trap 'kill "$appium_pid" 2>/dev/null || true' EXIT
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
  const summary="D2L01-iOS: PASS — native background/resume, encrypted history/draft purge, permanent-channel control (AUTOMATED / SIMULATOR).\n";
  if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
'
