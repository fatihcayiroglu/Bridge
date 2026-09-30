#!/usr/bin/env bash
# e2e/ios/run-simulator-smoke.sh — P4 iOS SIMULATOR SMOKE (AUTOMATED / SIMULATOR evidence)
#
# Runs on a macOS runner after `xcodebuild` produced the Debug simulator .app. It installs and
# cold-launches the real app on an iOS simulator and records PASS / FAIL / MEASURED results.
# It is NOT device evidence: no real radio, no APNs delivery, no microphone/camera hardware. The
# WKWebView content is not driven (no WebDriver for it here); what is asserted is what the OS and
# the app's own console can prove.
set -uo pipefail

OUT="${IOS_EVIDENCE_DIR:-e2e/ios/results}"
APP="${IOS_APP_PATH:?IOS_APP_PATH is required}"
BUNDLE_ID="${IOS_BUNDLE_ID:-com.bridge.app}"
mkdir -p "$OUT"
RESULTS="$OUT/ios-evidence.txt"
: > "$RESULTS"
fails=0
# Every simulator command gets a hard time limit (macOS has no coreutils `timeout`), and progress is
# timestamped, so a hang shows WHERE it happened instead of eating the job's whole timeout.
limit() { local secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }
step() { echo "[ios-smoke $(date -u +%H:%M:%S)] $*"; }
record() { # status id title detail
  printf '%-8s %-5s %s\n          ↳ %s\n' "$1" "$2" "$3" "$4" | tee -a "$RESULTS"
  [ "$1" = "FAIL" ] && fails=$((fails + 1))
  return 0
}

# ── I01: the BUILT bundle carries the privacy strings, scheme and version ────────────────────
info="$APP/Info.plist"
mic=$(/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$info" 2>/dev/null || true)
cam=$(/usr/libexec/PlistBuddy -c 'Print :NSCameraUsageDescription' "$info" 2>/dev/null || true)
scheme=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes:0' "$info" 2>/dev/null || true)
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info" 2>/dev/null || true)
if [ -n "$mic" ] && [ -n "$cam" ] && [ "$scheme" = "bridge" ]; then
  record PASS I01 "built app declares microphone/camera usage and the bridge:// scheme" "version=$version scheme=$scheme"
else
  record FAIL I01 "built app declares microphone/camera usage and the bridge:// scheme" "mic='${mic}' cam='${cam}' scheme='${scheme}' version='${version}'"
fi

# ── Simulator ───────────────────────────────────────────────────────────────────────────────
step "selecting a simulator"
UDID=$(limit 120 xcrun simctl list devices available -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
cands=[(rt,x) for rt,xs in d.items() if "iOS" in rt for x in xs if x["name"].startswith("iPhone")]
cands.sort(key=lambda c: c[0])
print(cands[-1][1]["udid"] if cands else "")')
if [ -z "$UDID" ]; then record FAIL I00 "an iPhone simulator is available" "none found"; exit 1; fi
DEVICE=$(limit 60 xcrun simctl list devices | grep "$UDID" | head -1 | sed 's/^ *//')
step "simulator: $DEVICE"
limit 240 xcrun simctl boot "$UDID" 2>/dev/null || true
step "waiting for boot"
if ! limit 480 xcrun simctl bootstatus "$UDID" -b >/dev/null; then
  record FAIL I00 "the simulator boots" "bootstatus did not finish within 480 s ($DEVICE)"
  exit 1
fi
step "installing the app"
if ! limit 240 xcrun simctl install "$UDID" "$APP"; then
  record FAIL I00 "the app installs on the simulator" "simctl install did not finish within 240 s"
  exit 1
fi

# ── I02 / I03: cold launch survives and the native bridge comes up in the WebView ────────────
start=$(date +%s)
step "launching $BUNDLE_ID"
limit 300 xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE_ID" > "$OUT/console.log" 2>&1 < /dev/null &
LAUNCH_PID=$!
sleep 25
limit 60 xcrun simctl io "$UDID" screenshot "$OUT/cold-launch.png" >/dev/null 2>&1 || true
alive=$(limit 60 xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -c "$BUNDLE_ID" || true)
if [ "$alive" -ge 1 ]; then
  record PASS I02 "cold launch: the app process is alive 25 s after launch" "device=$DEVICE"
else
  record FAIL I02 "cold launch: the app process is alive 25 s after launch" "$(tail -20 "$OUT/console.log" | tr '\n' ' ' | cut -c1-600)"
fi
if grep -q "Capacitor entegrasyonu hazır — ios" "$OUT/console.log"; then
  record PASS I03 "the web app and native bridge load inside WKWebView" "ready log after launch"
else
  record FAIL I03 "the web app and native bridge load inside WKWebView" "$(grep -E '\[(log|error|warn)\]' "$OUT/console.log" | tail -8 | tr '\n' ' ' | cut -c1-600)"
fi

# ── I04: a bridge:// link reaches the running app ────────────────────────────────────────────
step "opening bridge://channel/p4-ios-smoke-channel"
limit 60 xcrun simctl openurl "$UDID" "bridge://channel/p4-ios-smoke-channel" || true
sleep 6
if grep -q "Deep link dispatched: navigate:channel" "$OUT/console.log"; then
  record PASS I04 "bridge://channel/<id> reaches the running app (bridge dispatch)" "routing itself is covered by the Android emulator and unit tests"
else
  record FAIL I04 "bridge://channel/<id> reaches the running app (bridge dispatch)" "$(grep -i 'deep' "$OUT/console.log" | tail -5 | tr '\n' ' ' | cut -c1-400)"
fi
limit 60 xcrun simctl io "$UDID" screenshot "$OUT/after-deeplink.png" >/dev/null 2>&1 || true
record MEASURED I05 "time from launch command to evidence capture" "$(( $(date +%s) - start )) s (includes fixed waits)"

kill "$LAUNCH_PID" 2>/dev/null || true
limit 120 xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
step "done"
tail -n 40 "$OUT/console.log" || true
echo "TOTAL fail=$fails (evidence category: AUTOMATED / SIMULATOR — not device evidence)" | tee -a "$RESULTS"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
