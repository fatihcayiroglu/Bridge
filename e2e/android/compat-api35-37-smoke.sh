#!/usr/bin/env bash
# A bounded, non-gating-by-default OS compatibility smoke test.
# This does not replace the required API34 product journey suite and cannot
# establish notification/camera/microphone/full-chat compatibility on its own.
set -euo pipefail

api="$1"
apk="$2"
case "$api" in
  35|36|37) ;;
  *) echo "::error::Unsupported smoke-test Android API: $api"; exit 1 ;;
esac
test -s "$apk" || { echo "::error::Android debug APK is missing"; exit 1; }

# Android 17 API37 revision < 5 has a Google Play services certification
# issue affecting GMS clients: explicitly reject that unsupported test fixture.
if [[ "$api" == 37 ]]; then
  sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
  props="$sdk_root/system-images/android-37.0/google_apis/x86_64/source.properties"
  test -s "$props" || { echo "::error::API37 image revision metadata unavailable"; exit 1; }
  revision="$(sed -n 's/^Pkg.Revision=//p' "$props" | head -n1)"
  if [[ ! "$revision" =~ ^[0-9]+([.][0-9]+)*$ ]]; then
    echo "::error::API37 image revision is unreadable"
    exit 1
  fi
  major="${revision%%.*}"
  if (( 10#$major < 5 )); then
    echo "::error::API37 image revision $revision is affected by the known GMS bug; require >=5"
    exit 1
  fi
  echo "API37 Google APIs image revision $revision (>=5)"
fi

sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r\n')"
release="$(adb shell getprop ro.build.version.release | tr -d '\r\n')"
if [[ "$sdk" != "$api" ]]; then
  echo "::error::Emulator API mismatch: expected $api, observed $sdk"
  exit 1
fi
boot="$(adb shell getprop sys.boot_completed | tr -d '\r\n')"
test "$boot" = 1 || { echo "::error::Emulator did not complete boot"; exit 1; }

pkg="com.bridge.app.debug"
activity="$pkg/com.bridge.app.MainActivity"

# Android may kill a background process because of an app crash, ANR, or an
# OS policy. Show only bounded numeric ApplicationExitInfo reason/subreason
# codes, NEVER raw dumpsys descriptions (they can contain user data). This
# diagnostic cannot by itself tie an exit to a particular PID; the gate remains
# FAIL when a required live-process assertion fails.
exit_reason_evidence() {
  local raw codes
  raw="$(adb shell dumpsys activity exit-info "$pkg" 2>/dev/null || true)"
  codes="$(printf '%s' "$raw" | grep -Eo '(reason|subreason)=[0-9]{1,4}' | head -n 6 | tr '\n' ' ' || true)"
  echo "recent OS app exit reason codes (not PID-attributed): ${codes:-unavailable}"
}
echo "Android $release / API $sdk: installing exact CI debug APK"
adb install -r "$apk"

# No backend connection is required to prove native launch and a bounded
# background/resume. We do NOT claim a login/message/notification PASS here.
adb shell am start -W -n "$activity" >/dev/null
sleep 10
before="$(adb shell pidof "$pkg" 2>/dev/null | tr -d '\r\n' || true)"
if [[ ! "$before" =~ ^[0-9]{1,8}$ ]]; then
  exit_reason_evidence
  echo "::error::App failed to remain alive after cold launch (API $api)"
  exit 1
fi
echo "COLD LAUNCH: PASS"

adb shell input keyevent KEYCODE_HOME
sleep 8
background="$(adb shell pidof "$pkg" 2>/dev/null | tr -d '\r\n' || true)"
if [[ "$background" != "$before" ]]; then
  exit_reason_evidence
  echo "::error::App process died in short background interval (API $api); original PID not alive"
  exit 1
fi

adb shell am start -W -n "$activity" >/dev/null
sleep 10
after="$(adb shell pidof "$pkg" 2>/dev/null | tr -d '\r\n' || true)"
if [[ "$after" != "$before" ]]; then
  exit_reason_evidence
  echo "::error::Hot resume lost the original process (API $api)"
  exit 1
fi
echo "SHORT BACKGROUND/HOT RESUME: PASS"
echo "API $api COMPATIBILITY SMOKE: 2 PASS / 0 FAIL / 0 SKIPPED (not full product acceptance)"
