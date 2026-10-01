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
schemes=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes' "$info" 2>/dev/null | tr -d ' ' | grep -v -E '^(Array\{|\})$' | tr '\n' ',' || true)
scheme=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes:0' "$info" 2>/dev/null || true)
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info" 2>/dev/null || true)
if [ -n "$mic" ] && [ -n "$cam" ] && [ "$scheme" = "com.bridge.app" ]; then
  record PASS I01 "built app declares microphone/camera usage and its own com.bridge.app:// scheme" "version=$version schemes=$schemes"
else
  record FAIL I01 "built app declares microphone/camera usage and its own com.bridge.app:// scheme" "mic='${mic}' cam='${cam}' schemes='${schemes}' version='${version}'"
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
# The app's stdout/stderr go straight to files, unbuffered. (Relayed through `--console-pty`,
# Capacitor's console lines arrived minutes late or not at all before the relay was stopped —
# Swift `print` is block-buffered when stdout is not a terminal; Xcode sets NSUnbufferedIO=YES for
# the same reason. SIMCTL_CHILD_* is passed into the app's environment.)
CONSOLE="$(pwd)/$OUT/console.log"
CONSOLE_ERR="$(pwd)/$OUT/console.err.log"
: > "$CONSOLE"; : > "$CONSOLE_ERR"
step "launching $BUNDLE_ID (stdout/stderr → files, NSUnbufferedIO)"
launch_out=$(SIMCTL_CHILD_NSUnbufferedIO=YES limit 300 xcrun simctl launch --terminate-running-process \
  --stdout="$CONSOLE" --stderr="$CONSOLE_ERR" "$UDID" "$BUNDLE_ID" 2>&1 || true)
launched_pid=$(printf '%s\n' "$launch_out" | sed -n "s/^${BUNDLE_ID}: \([0-9][0-9]*\).*/\1/p" | head -1)
step "launch returned after $(( $(date +%s) - start )) s: ${launch_out}"
console() { cat "$CONSOLE" "$CONSOLE_ERR" 2>/dev/null; }
ready=0
for _ in $(seq 1 90); do
  if console | grep -q "Capacitor entegrasyonu hazır — ios"; then ready=1; break; fi
  sleep 2
done
ready_after=$(( $(date +%s) - start ))
limit 60 xcrun simctl io "$UDID" screenshot "$OUT/cold-launch.png" >/dev/null 2>&1 || true
# The OS's own view: launchctl lists `<pid> <status> UIKitApplication:<bundle>[…]` for a running app.
os_pid=$(limit 60 xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | awk -v b="UIKitApplication:$BUNDLE_ID" 'index($3, b) == 1 && $1 ~ /^[0-9]+$/ { print $1; exit }')
alive=$([ -n "$os_pid" ] && echo 1 || echo 0)
[ -z "$launched_pid" ] && launched_pid="$os_pid"
if [ "$alive" -ge 1 ]; then
  record PASS I02 "cold launch: the app process is alive after launch" "device=$DEVICE pid=$os_pid (launchctl)"
else
  record FAIL I02 "cold launch: the app process is alive after launch" "launchctl has no running $BUNDLE_ID; launch: ${launch_out}; console: $(console | tail -5 | tr '\n' ' ' | cut -c1-400)"
fi
if [ "$ready" = 1 ]; then
  record PASS I03 "the web app and native bridge load inside WKWebView" "ready log ${ready_after} s after the launch command"
else
  record FAIL I03 "the web app and native bridge load inside WKWebView" "$(console | grep -E '\[(log|error|warn)\]|⚡️' | tail -8 | tr '\n' ' ' | cut -c1-600)"
fi

# ── I04: a com.bridge.app:// link reaches the running app ────────────────────────────────────
if [ -n "$launched_pid" ]; then
  step "opening com.bridge.app://channel/p4-ios-smoke-channel"
  limit 120 xcrun simctl openurl "$UDID" "com.bridge.app://channel/p4-ios-smoke-channel" 2>&1 | tail -3 || true
  for _ in $(seq 1 30); do
    console | grep -q "Deep link dispatched: navigate:channel" && break
    sleep 2
  done
fi
if console | grep -q "Deep link dispatched: navigate:channel"; then
  record PASS I04 "com.bridge.app://channel/<id> reaches the running app (bridge dispatch)" "routing itself is covered by the Android emulator and unit tests"
else
  record FAIL I04 "com.bridge.app://channel/<id> reaches the running app (bridge dispatch)" "$(console | grep -i -E 'deep|appUrlOpen|url' | tail -5 | tr '\n' ' ' | cut -c1-400)"
fi
limit 60 xcrun simctl io "$UDID" screenshot "$OUT/after-deeplink.png" >/dev/null 2>&1 || true
record MEASURED I05 "launch command → WKWebView bridge ready (simulator on a CI runner)" "${ready_after} s"

# Diagnostics in the job log itself (artifacts are not always reachable from where evidence is read).
step "console tail"
console | tail -n 60 | cut -c1-300 || true
crash=$(ls -t "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | grep -E '^App[-_.]' | head -1)
if [ -n "$crash" ]; then
  step "crash report: $crash"
  head -c 4000 "$HOME/Library/Logs/DiagnosticReports/$crash" || true
  echo
fi

limit 60 xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true

# ── I06 (diagnostic, MEASURED): who may own `bridge://` on iOS? ──────────────────────────────
# Run AFTER the evidence above, on a separate install, so I01-I05 describe the real build.
# Every installed app — system apps included — whose Info.plist claims the scheme, and what the OS
# does with a bridge:// link. (Run 36821042911: com.apple.Bridge claims it; openurl → -10814 while a
# unique control scheme on the same build opened — the reason for com.bridge.app://.)
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
bridge_open=$(limit 120 xcrun simctl openurl "$UDID" "bridge://channel/p4-ios-bridge-scheme" 2>&1 | tail -1)
record MEASURED I06 "who owns bridge:// on iOS (why the app uses com.bridge.app://)" \
  "claimants=[${claimants}] bridge_openurl='${bridge_open:-ok}'"

limit 120 xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
step "done"
echo "TOTAL fail=$fails (evidence category: AUTOMATED / SIMULATOR — not device evidence)" | tee -a "$RESULTS"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
