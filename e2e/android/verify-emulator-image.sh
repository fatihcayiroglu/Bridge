#!/usr/bin/env bash
# e2e/android/verify-emulator-image.sh — preflight the exact emulator image the
# Android workflows boot (mobile-android.yml and the #209 upstream WebView
# diagnostics). sdkmanager can return after a corrupt/transient ZipFile
# download without installing the image; the emulator action would then fail
# during setup, before any journeys. Retries ONLY the SDK installation, never
# a failed Bridge test or emulator run.
set -euo pipefail
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
image_dir="$sdk_root/system-images/android-34/google_apis/x86_64"
valid_image() {
  test -s "$image_dir/system.img" && test -s "$image_dir/package.xml"
}
if valid_image; then
  echo "Android API34 Google APIs x86_64 image already installed"
  exit 0
fi
# GitHub's hosted Android SDK has cmdline-tools installed, but its
# sdkmanager executable is not guaranteed to be on PATH in a bash
# run step (the emulator-runner action configures its own environment).
sdkmanager_bin=""
for candidate in "$sdk_root"/cmdline-tools/*/bin/sdkmanager "$sdk_root"/tools/bin/sdkmanager; do
  if [[ -x "$candidate" ]]; then
    sdkmanager_bin="$candidate"
    break
  fi
done
if [[ -z "$sdkmanager_bin" ]]; then
  echo "::error::Android SDK cmdline-tools sdkmanager not found under SDK root"
  exit 1
fi
# The runner normally accepts licenses during its own setup;
# this preflight executes before it. The actual install and image
# verification below remain strict even if licenses are unavailable.
yes | "$sdkmanager_bin" --sdk_root="$sdk_root" --licenses > /dev/null || true
for attempt in 1 2; do
  echo "Installing Android API34 Google APIs image, attempt $attempt/2"
  if "$sdkmanager_bin" --sdk_root="$sdk_root" --install 'system-images;android-34;google_apis;x86_64' --channel=0 && valid_image; then
    echo "Android API34 Google APIs image verified"
    exit 0
  fi
  if [[ $attempt -eq 1 ]]; then
    echo "::warning::Android system image install incomplete; retrying SDK package only"
    sleep 8
  fi
done
echo "::error::Android system image is missing or incomplete; emulator tests were not run"
exit 1
