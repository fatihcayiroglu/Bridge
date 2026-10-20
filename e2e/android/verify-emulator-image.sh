#!/usr/bin/env bash
# e2e/android/verify-emulator-image.sh — preflight exactly the packages used
# by the API 34 Google APIs x86_64 CI emulator. A truncated SDK ZIP must not
# turn into a fake-green Android run. Recover only *installation* failures:
# never retry a Bridge assertion, emulator journey, or failed device test.
set -euo pipefail

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
image_dir="$sdk_root/system-images/android-34/google_apis/x86_64"
emulator_dir="$sdk_root/emulator"
valid_image() {
  test -s "$image_dir/system.img" && test -s "$image_dir/package.xml"
}
valid_emulator() {
  test -x "$emulator_dir/emulator" && test -s "$emulator_dir/source.properties"
}
if valid_image && valid_emulator; then
  echo "Android emulator and API34 Google APIs x86_64 image already installed"
  exit 0
fi

# sdkmanager is installed under the hosted SDK, but often not on PATH until
# android-emulator-runner sets up its shell. Resolve it ourselves.
sdkmanager_bin=""
for candidate in "$sdk_root"/cmdline-tools/latest/bin/sdkmanager "$sdk_root"/cmdline-tools/*/bin/sdkmanager "$sdk_root"/tools/bin/sdkmanager; do
  if [[ -x "$candidate" ]]; then
    sdkmanager_bin="$candidate"
    break
  fi
done
if [[ -z "$sdkmanager_bin" ]]; then
  echo "::error::Android SDK cmdline-tools sdkmanager not found under SDK root"
  exit 1
fi
yes | "$sdkmanager_bin" --sdk_root="$sdk_root" --licenses > /dev/null || true

# Only the SDK installation may be retried. This runner is ephemeral; removing
# its partially unpacked package and SDK download staging is safe. Do not
# delete other installed Android packages or change the emulator image/API.
retry_delay="${SDK_PREFLIGHT_RETRY_DELAY_SECONDS:-8}"
if [[ ! "$retry_delay" =~ ^[0-9]{1,2}$ ]]; then
  echo "::error::SDK_PREFLIGHT_RETRY_DELAY_SECONDS must be an integer from 0 to 99"
  exit 1
fi

install_verified() {
  local label="$1" package="$2" package_dir="$3" predicate="$4"
  local attempt
  if "$predicate"; then
    echo "$label already verified"
    return 0
  fi
  for attempt in 1 2 3; do
    echo "Installing $label, attempt $attempt/3"
    if "$sdkmanager_bin" --sdk_root="$sdk_root" --install "$package" --channel=0 && "$predicate"; then
      echo "$label verified"
      return 0
    fi
    # SDK Manager can leave truncated ZIPs under .temp or
    # .downloadIntermediates and partially extracted destination directories.
    # Retrying with those artifacts in place can reproduce the same failure.
    if ! "$predicate"; then
      rm -rf -- "$package_dir"
    fi
    rm -rf -- "$sdk_root/.temp" "$sdk_root/.downloadIntermediates"
    if [[ $attempt -ne 3 ]]; then
      echo "::warning::$label installation incomplete; clearing partial SDK package and retrying"
      sleep "$retry_delay"
    fi
  done
  echo "::error::$label missing or incomplete after 3 SDK install attempts; Android emulator tests were NOT run"
  return 1
}

# Installing the emulator separately prevents sdkmanager's image install from
# silently interleaving an emulator package download with the much larger
# system image download. Verify both artifacts before running any journeys.
install_verified "Android emulator" "emulator" "$emulator_dir" valid_emulator
install_verified "Android API34 Google APIs x86_64 image" \
  "system-images;android-34;google_apis;x86_64" "$image_dir" valid_image

# Fail closed on missing files even if sdkmanager returned a success exit code.
valid_emulator && valid_image || {
  echo "::error::Android SDK preflight incomplete; Android emulator tests were NOT run"
  exit 1
}
echo "Android API34 Google APIs emulator preflight complete"
