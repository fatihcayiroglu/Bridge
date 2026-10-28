#!/usr/bin/env bash
# Real iOS Simulator devices, normal signed-out RN screen, portrait only.
# Physical iPhones/iCloud restore and authenticated journeys are NOT covered.
set -euo pipefail
cd mobile-native-pilot
mkdir -p native-evidence/layout-ios
report=native-evidence/layout-ios/results.json
node scripts/layout-profiles.mjs init ios "$report"
active_profile=''
stage=prerequisites
owned_udids=native-evidence/layout-ios/created-udids.txt
: > "$owned_udids"
metro_pid=''
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    echo "NATIVE_IOS_LAYOUT_FIRST_FAILURE profile=${active_profile:-none} stage=$stage exit=$status" >&2
    if [[ -n "$active_profile" ]]; then
      node scripts/layout-profiles.mjs set "$report" "$active_profile" FAIL "$stage" || true
    fi
  fi
  # Only shut down/delete simulator IDs created by this script.
  while IFS= read -r udid; do
    [[ -n "$udid" ]] || continue
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  done < "$owned_udids"
  if [[ -n "$metro_pid" ]]; then kill "$metro_pid" 2>/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT

stage=runtime-inventory
xcrun simctl list runtimes -j > native-evidence/layout-ios/runtimes.json
xcrun simctl list devicetypes -j > native-evidence/layout-ios/devicetypes.json
runtime=$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); const a=d.runtimes.filter(x=>x.isAvailable && (x.platform==="iOS" || /SimRuntime\.iOS/.test(x.identifier))); a.sort((x,y)=>(y.version||"").localeCompare(x.version||"",undefined,{numeric:true})); if(!a[0]) process.exit(1); console.log(a[0].identifier)' native-evidence/layout-ios/runtimes.json)
node scripts/layout-profiles.mjs ios-device-types native-evidence/layout-ios/devicetypes.json > native-evidence/layout-ios/profiles.tsv
test "$(wc -l < native-evidence/layout-ios/profiles.tsv | tr -d ' ')" = 4
stage=vision-compile
xcrun swiftc scripts/native-screenshot-text.swift -o native-evidence/layout-ios/read-native-screen
stage=metro-start
npx expo start --localhost --port 8081 > native-evidence/layout-ios/metro.log 2>&1 &
metro_pid=$!
stage=metro-ready
ready=0
for _ in $(seq 1 60); do
  kill -0 "$metro_pid"
  if curl --fail --silent --max-time 4 http://127.0.0.1:8081/status | grep -q '^packager-status:running$'; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'IOS_METRO_NOT_READY'; exit 1; }
stage=bundle-ready
curl --fail --silent --show-error --max-time 180 'http://127.0.0.1:8081/index.bundle?platform=ios&dev=true&minify=false' -o /dev/null
stage=built-app
app=$(find "$RUNNER_TEMP/bridge-layout-ios/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' -print -quit)
[[ -n "$app" ]] && test -d "$app"

# simctl may read stdin too; never allow it to eat the profile list.
while IFS=$'\t' read -r -u 3 id device_id device_label; do
  active_profile="$id"
  stage="${id}-device-inventory"
  out="native-evidence/layout-ios/$id"
  mkdir -p "$out"
  if [[ "$device_id" == UNAVAILABLE ]]; then
    echo "NATIVE_IOS_LAYOUT_NOT_EXECUTED $id DEVICE_TYPE_UNAVAILABLE" >&2
    node scripts/layout-profiles.mjs set "$report" "$id" NOT_EXECUTED DEVICE_TYPE_UNAVAILABLE
    active_profile=''
    continue
  fi
  printf 'runtime=%s\ndevice_type=%s\ndevice_id=%s\n' "$runtime" "$device_label" "$device_id" > "$out/device.txt"
  stage="${id}-create"
  udid=$(xcrun simctl create "BridgeLayout-${id}-${GITHUB_RUN_ID:-local}" "$device_id" "$runtime")
  echo "$udid" >> "$owned_udids"
  stage="${id}-boot"
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > "$out/boot.txt" 2>&1
  stage="${id}-install"
  xcrun simctl install "$udid" "$app" > "$out/install.txt" 2>&1
  stage="${id}-launch"
  xcrun simctl launch "$udid" com.bridge.nativepilot > "$out/launch.txt" 2>&1
  stage="${id}-rendered-ui"
  found=0
  for attempt in $(seq 1 24); do
    xcrun simctl io "$udid" screenshot "$out/screen.png" > "$out/screenshot-output.txt" 2>&1
    native-evidence/layout-ios/read-native-screen "$out/screen.png" > "$out/visible-text.txt"
    # Join OCR line wraps but require the real text visible on the screenshot.
    visible=$(tr '\n' ' ' < "$out/visible-text.txt")
    if grep -Eq 'Unable to load script|NATIVE_ACCEPTANCE_FAILED|React Native Error' "$out/visible-text.txt"; then
      echo "NATIVE_IOS_LAYOUT_RUNTIME_ERROR $id" >&2; exit 1
    fi
    if grep -Fqx 'Bridge' "$out/visible-text.txt" &&
       [[ "$visible" == *'Session: signed-out'* ]] &&
       [[ "$visible" == *'Sign in with your browser'* ]]; then
      found=1; break
    fi
    sleep 3
  done
  if [[ "$found" != 1 ]]; then
    echo "NATIVE_IOS_LAYOUT_ASSERTION_FAILED $id" >&2
    tail -n 30 "$out/visible-text.txt" >&2 || true
    exit 1
  fi
  test -s "$out/screen.png"
  node scripts/layout-profiles.mjs set "$report" "$id" PASS
  echo "NATIVE_IOS_LAYOUT $id PASS device=$device_label"
  active_profile=''
  stage="${id}-shutdown"
  xcrun simctl shutdown "$udid"
done 3< native-evidence/layout-ios/profiles.tsv
stage=complete-gate
node scripts/layout-profiles.mjs assert-complete "$report"
echo 'NATIVE_IOS_SIGNED_OUT_LAYOUT_MATRIX=PASS'
