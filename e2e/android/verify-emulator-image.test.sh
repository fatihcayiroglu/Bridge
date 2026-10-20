#!/usr/bin/env bash
# Offline CI contract for the SDK preflight. Fake sdkmanager never accesses a
# network or a real Android SDK; tests only corrupt-package recovery and the
# mandatory fail-closed path. Android emulator journeys remain separate gates.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

make_fake_sdk() {
  local root="$1"
  mkdir -p "$root/cmdline-tools/latest/bin"
  cat > "$root/cmdline-tools/latest/bin/sdkmanager" <<'FAKE_SDKMANAGER'
#!/usr/bin/env bash
set -euo pipefail
root="${ANDROID_HOME:?}"
args=" $* "
if [[ "$args" == *" --licenses "* ]]; then exit 0; fi

kind=""
if [[ "$args" == *" --install emulator "* ]]; then
  kind=emulator
  dest="$root/emulator"
elif [[ "$args" == *" --install system-images;android-34;google_apis;x86_64 "* ]]; then
  kind=image
  dest="$root/system-images/android-34/google_apis/x86_64"
else
  echo "unexpected fake sdkmanager arguments" >&2
  exit 9
fi
counter="$root/$kind.attempts"
number=0
if [[ -f "$counter" ]]; then read -r number < "$counter"; fi
number=$((number + 1))
printf '%s\n' "$number" > "$counter"
# A previous truncated ZIP or half-unpacked destination must not survive.
if [[ -e "$root/.temp/truncated" || -e "$root/.downloadIntermediates/truncated" || -e "$dest/partial" ]]; then
  echo "preflight did not remove corrupt staged package" >&2
  exit 8
fi
if [[ "$number" == 1 || "${SDK_TEST_ALWAYS_FAIL:-0}" == 1 ]]; then
  mkdir -p "$dest" "$root/.temp" "$root/.downloadIntermediates"
  printf 'partial\n' > "$dest/partial"
  printf 'badzip\n' > "$root/.temp/truncated"
  printf 'badzip\n' > "$root/.downloadIntermediates/truncated"
  echo 'Error on ZipFile unknown archive' >&2
  exit 1
fi
mkdir -p "$dest"
if [[ "$kind" == emulator ]]; then
  printf '#!/bin/sh\nexit 0\n' > "$dest/emulator"
  chmod +x "$dest/emulator"
  printf 'Pkg.Revision=1\n' > "$dest/source.properties"
else
  printf 'sdk-image\n' > "$dest/system.img"
  printf '<sdk-repository/>\n' > "$dest/package.xml"
fi
FAKE_SDKMANAGER
  chmod +x "$root/cmdline-tools/latest/bin/sdkmanager"
}

success_root="$tmp/recovers"
make_fake_sdk "$success_root"
ANDROID_HOME="$success_root" SDK_PREFLIGHT_RETRY_DELAY_SECONDS=0 \
  bash "$here/verify-emulator-image.sh" > "$tmp/recovers.log" 2>&1 || {
  cat "$tmp/recovers.log" >&2
  echo "FAIL: incomplete SDK ZIP should be recovered" >&2
  exit 1
}
test -s "$success_root/emulator/source.properties"
test -x "$success_root/emulator/emulator"
test -s "$success_root/system-images/android-34/google_apis/x86_64/system.img"
test -s "$success_root/system-images/android-34/google_apis/x86_64/package.xml"
test "$(cat "$success_root/emulator.attempts")" = 2
test "$(cat "$success_root/image.attempts")" = 2
grep -q "Android API34 Google APIs emulator preflight complete" "$tmp/recovers.log"

# Already verified SDK packages must be reused without a new download.
ANDROID_HOME="$success_root" SDK_PREFLIGHT_RETRY_DELAY_SECONDS=0 \
  bash "$here/verify-emulator-image.sh" > "$tmp/reused.log" 2>&1
test "$(cat "$success_root/emulator.attempts")" = 2
test "$(cat "$success_root/image.attempts")" = 2

# A permanently bad download must leave the CI red: never record a PASS for
# an Android journey that was not run, and never fall back to another API image.
broken_root="$tmp/permanently-broken"
make_fake_sdk "$broken_root"
if ANDROID_HOME="$broken_root" SDK_PREFLIGHT_RETRY_DELAY_SECONDS=0 SDK_TEST_ALWAYS_FAIL=1 \
    bash "$here/verify-emulator-image.sh" > "$tmp/broken.log" 2>&1; then
  echo "FAIL: permanently broken SDK package was accepted" >&2
  exit 1
fi
test "$(cat "$broken_root/emulator.attempts")" = 3
grep -q "Android emulator tests were NOT run" "$tmp/broken.log"
test ! -e "$broken_root/emulator/emulator"

# Missing sdkmanager must be an explicit failure, not an implicit skip.
missing_root="$tmp/sdkmanager-missing"
mkdir -p "$missing_root"
if ANDROID_HOME="$missing_root" bash "$here/verify-emulator-image.sh" > "$tmp/missing.log" 2>&1; then
  echo "FAIL: preflight accepted a missing sdkmanager" >&2
  exit 1
fi
grep -q "sdkmanager not found" "$tmp/missing.log"

echo "SDK preflight synthetic regressions: 4 PASS / 0 FAIL / 0 SKIPPED"
