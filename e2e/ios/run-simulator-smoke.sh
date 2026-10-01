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
BUNDLE_ID="${IOS_BUNDLE_ID:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null || echo com.bridge.app)}"
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
# The container path proves the install registered with the simulator (LaunchServices).
container=$(limit 60 xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" 2>&1 || true)
step "app container: ${container}"
start=$(date +%s)
step "launching $BUNDLE_ID (JS console via --console-pty)"
limit 600 xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE_ID" > "$OUT/console.log" 2>&1 < /dev/null &
LAUNCH_PID=$!
# Poll instead of a fixed wait: the first line is "<bundle>: <pid>", then Capacitor's console lines.
launched_pid=""
for _ in $(seq 1 90); do
  launched_pid=$(sed -n "s/^${BUNDLE_ID}: \([0-9][0-9]*\).*/\1/p" "$OUT/console.log" | head -1)
  [ -n "$launched_pid" ] && break
  kill -0 "$LAUNCH_PID" 2>/dev/null || break
  sleep 2
done
step "launch reported pid='${launched_pid}' after $(( $(date +%s) - start )) s"
ready=0
for _ in $(seq 1 45); do
  if grep -q "Capacitor entegrasyonu hazır — ios" "$OUT/console.log"; then ready=1; break; fi
  sleep 2
done
limit 60 xcrun simctl io "$UDID" screenshot "$OUT/cold-launch.png" >/dev/null 2>&1 || true
alive=$(limit 60 xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -c "$BUNDLE_ID" || true)
if [ -n "$launched_pid" ] && [ "$alive" -ge 1 ]; then
  record PASS I02 "cold launch: the app process is alive after launch" "device=$DEVICE pid=$launched_pid"
else
  record FAIL I02 "cold launch: the app process is alive after launch" "pid='${launched_pid}' launchctl=${alive} console: $(tail -5 "$OUT/console.log" | tr '\n' ' ' | cut -c1-400)"
fi
if [ "$ready" = 1 ]; then
  record PASS I03 "the web app and native bridge load inside WKWebView" "ready log after $(( $(date +%s) - start )) s"
else
  record FAIL I03 "the web app and native bridge load inside WKWebView" "$(grep -E '\[(log|error|warn)\]|⚡️' "$OUT/console.log" | tail -8 | tr '\n' ' ' | cut -c1-600)"
fi

# ── I04: a bridge:// link reaches the running app ────────────────────────────────────────────
if [ -n "$launched_pid" ]; then
  step "opening bridge://channel/p4-ios-smoke-channel"
  limit 120 xcrun simctl openurl "$UDID" "bridge://channel/p4-ios-smoke-channel" 2>&1 | tail -3 || true
  for _ in $(seq 1 15); do
    grep -q "Deep link dispatched: navigate:channel" "$OUT/console.log" && break
    sleep 2
  done
fi
if grep -q "Deep link dispatched: navigate:channel" "$OUT/console.log"; then
  record PASS I04 "bridge://channel/<id> reaches the running app (bridge dispatch)" "routing itself is covered by the Android emulator and unit tests"
else
  record FAIL I04 "bridge://channel/<id> reaches the running app (bridge dispatch)" "$(grep -i 'deep' "$OUT/console.log" | tail -5 | tr '\n' ' ' | cut -c1-400)"
fi
limit 60 xcrun simctl io "$UDID" screenshot "$OUT/after-deeplink.png" >/dev/null 2>&1 || true
record MEASURED I05 "time from launch command to evidence capture" "$(( $(date +%s) - start )) s (polling, no fixed waits)"

# Diagnostics in the job log itself (artifacts are not always reachable from where evidence is read).
step "console tail"
tail -n 60 "$OUT/console.log" | cut -c1-300 || true
crash=$(ls -t "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | grep -E '^App[-_.]' | head -1)
if [ -n "$crash" ]; then
  step "crash report: $crash"
  head -c 4000 "$HOME/Library/Logs/DiagnosticReports/$crash" || true
  echo
fi

kill "$LAUNCH_PID" 2>/dev/null || true

# ── I06 (diagnostic, MEASURED): who may own `bridge://` on iOS? ──────────────────────────────
# Run AFTER the evidence above, on a separate install, so I01-I05 describe the real build.
# (1) every installed app — system apps included — whose Info.plist claims the scheme;
# (2) the same build with one extra, unique control scheme: if the control link reaches the app
#     while `bridge://` does not, the registration works and the `bridge` scheme itself is refused.
step "apps claiming the bridge scheme"
claimants=$(limit 60 xcrun simctl listapps "$UDID" 2>/dev/null | plutil -convert json -o - - 2>/dev/null | python3 -c '
import json, os, plistlib, sys
try:
    apps = json.load(sys.stdin)
except Exception as e:
    print("listapps unreadable: %s" % e); sys.exit(0)
hits = []
for bid, app in apps.items():
    path = app.get("Path") or ""
    try:
        info = plistlib.load(open(os.path.join(path, "Info.plist"), "rb"))
    except Exception:
        continue
    schemes = [s for t in info.get("CFBundleURLTypes", []) for s in t.get("CFBundleURLSchemes", [])]
    if any(str(s).lower() == "bridge" for s in schemes):
        hits.append("%s %s" % (bid, schemes))
print("; ".join(hits) if hits else "none")' 2>&1 | tail -1)
step "claimants: ${claimants}"
CONTROL_APP="$OUT/control/App.app"
rm -rf "$OUT/control" && mkdir -p "$OUT/control" && cp -R "$APP" "$CONTROL_APP"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:1 string bridgep4control' "$CONTROL_APP/Info.plist" >/dev/null 2>&1 || true
limit 240 xcrun simctl install "$UDID" "$CONTROL_APP" >/dev/null 2>&1 || true
: > "$OUT/control-console.log"
limit 300 xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE_ID" > "$OUT/control-console.log" 2>&1 < /dev/null &
CONTROL_PID=$!
for _ in $(seq 1 60); do grep -q "Capacitor entegrasyonu hazır — ios" "$OUT/control-console.log" && break; sleep 2; done
control_open=$(limit 120 xcrun simctl openurl "$UDID" "bridgep4control://channel/p4-ios-control" 2>&1 | tail -1)
for _ in $(seq 1 15); do grep -q "Deep link dispatched: navigate:channel" "$OUT/control-console.log" && break; sleep 2; done
bridge_open=$(limit 120 xcrun simctl openurl "$UDID" "bridge://channel/p4-ios-control" 2>&1 | tail -1)
control_reached=$(grep -c "Deep link dispatched: navigate:channel" "$OUT/control-console.log" || true)
record MEASURED I06 "scheme ownership: apps claiming bridge://, and a unique control scheme on the same build" \
  "claimants=[${claimants}] control_openurl='${control_open:-ok}' control_dispatches=${control_reached} bridge_openurl='${bridge_open:-ok}'"
kill "$CONTROL_PID" 2>/dev/null || true

limit 120 xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
step "done"
echo "TOTAL fail=$fails (evidence category: AUTOMATED / SIMULATOR — not device evidence)" | tee -a "$RESULTS"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
