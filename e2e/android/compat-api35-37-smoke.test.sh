#!/usr/bin/env bash
# Network-free regression harness for the Android 15–17 emulator smoke script.
# Fake adb/sleep exercises error handling without accepting a simulated device
# as genuine Android compatibility evidence.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/sdk/system-images/android-37/google_apis/x86_64"
printf 'fake apk\n' > "$tmp/app.apk"

cat > "$tmp/bin/adb" <<'FAKE_ADB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == shell && "$2" == getprop ]]; then
  case "$3" in
    ro.build.version.sdk) echo "$COMPAT_FAKE_SDK" ;;
    ro.build.version.release) echo "$COMPAT_FAKE_SDK" ;;
    sys.boot_completed) echo 1 ;;
    *) exit 3 ;;
  esac
  exit 0
fi
if [[ "$1" == install && "$2" == -r ]]; then echo Success; exit 0; fi
if [[ "$1" == shell && "$2" == am && "$3" == start ]]; then
  echo 'Status: ok'
  exit 0
fi
if [[ "$1" == shell && "$2" == input && "$3" == keyevent ]]; then exit 0; fi
if [[ "$1" == shell && "$2" == pidof ]]; then
  count=0
  if [[ -s "$COMPAT_FAKE_COUNTER" ]]; then read -r count < "$COMPAT_FAKE_COUNTER"; fi
  count=$((count + 1))
  echo "$count" > "$COMPAT_FAKE_COUNTER"
  if [[ "${COMPAT_FAKE_LOSE_PID:-0}" == 1 && "$count" -gt 1 ]]; then
    echo 5555
  else
    echo 4444
  fi
  exit 0
fi
echo "unhandled fake adb call: $*" >&2
exit 7
FAKE_ADB
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/sleep"
chmod +x "$tmp/bin/adb" "$tmp/bin/sleep"

run_smoke() {
  local api="$1" sdk="$2" rev="$3" lose="${4:-0}"
  printf '%s\n' "Pkg.Revision=$rev" > "$tmp/sdk/system-images/android-37/google_apis/x86_64/source.properties"
  rm -f "$tmp/counter"
  PATH="$tmp/bin:$PATH" ANDROID_HOME="$tmp/sdk" COMPAT_FAKE_SDK="$sdk" \
    COMPAT_FAKE_LOSE_PID="$lose" COMPAT_FAKE_COUNTER="$tmp/counter" \
    bash "$here/compat-api35-37-smoke.sh" "$api" "$tmp/app.apk" > "$tmp/output.log" 2>&1
}

run_smoke 35 35 0
grep -q "API 35 COMPATIBILITY SMOKE: 2 PASS" "$tmp/output.log"
run_smoke 36 36 0
grep -q "API 36 COMPATIBILITY SMOKE: 2 PASS" "$tmp/output.log"
run_smoke 37 37 5
grep -q "API 37 COMPATIBILITY SMOKE: 2 PASS" "$tmp/output.log"

if run_smoke 37 37 4; then
  echo "::error::API37 image revision 4 accepted unexpectedly"
  exit 1
fi
grep -q "known GMS bug" "$tmp/output.log"

if run_smoke 36 35 0; then
  echo "::error::Mismatched emulator API falsely passed"
  exit 1
fi
grep -q "Emulator API mismatch" "$tmp/output.log"

if run_smoke 35 35 0 1; then
  echo "::error::Background process loss falsely passed"
  exit 1
fi
grep -q "process died in short background" "$tmp/output.log"

echo "Offline Android API35–37 smoke contracts: 6 PASS / 0 FAIL / 0 SKIPPED (synthetic only)"
