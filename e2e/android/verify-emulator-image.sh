#!/usr/bin/env bash
# e2e/android/verify-emulator-image.sh — preflight the exact emulator image the
# Android workflows boot (mobile-android.yml and the #209 upstream WebView
# diagnostics). sdkmanager can return after a corrupt/transient ZipFile
# download without installing the package; the emulator action would then fail
# during setup, before any journeys. Retries ONLY the SDK installation, never
# a failed Bridge test or emulator run, and fails the job when the image and
# emulator are still not installed: unexecuted journeys are never a pass.
#
# Run 40029859999 hit "Error on ZipFile unknown archive" on two packages (the
# emulator on attempt 1, the system image on attempt 2) while other runs of
# the same hour installed both. sdkmanager keeps partial downloads in the SDK
# root; each retry now starts from a clean download, with backoff.
set -euo pipefail
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
image_dir="$sdk_root/system-images/android-34/google_apis/x86_64"
attempts="${ANDROID_SDK_INSTALL_ATTEMPTS:-4}"
backoff="${ANDROID_SDK_RETRY_BASE_SECONDS:-10}"
image_ok() { test -s "$image_dir/system.img" && test -s "$image_dir/package.xml"; }
emulator_ok() { test -x "$sdk_root/emulator/emulator" && test -s "$sdk_root/emulator/package.xml"; }
if image_ok && emulator_ok; then
  echo "Android API34 Google APIs x86_64 image and emulator already installed"
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
for ((attempt = 1; attempt <= attempts; attempt++)); do
  echo "Installing Android API34 Google APIs image and emulator, attempt $attempt/$attempts"
  # One package per call, each only while incomplete, so a corrupt download
  # of one package is retried without re-downloading the other.
  emulator_ok || "$sdkmanager_bin" --sdk_root="$sdk_root" --install 'emulator' --channel=0 || true
  image_ok || "$sdkmanager_bin" --sdk_root="$sdk_root" --install 'system-images;android-34;google_apis;x86_64' --channel=0 || true
  if image_ok && emulator_ok; then
    echo "Android API34 Google APIs image and emulator verified (attempt $attempt/$attempts)"
    exit 0
  fi
  if ((attempt < attempts)); then
    delay=$((backoff * (1 << (attempt - 1))))
    echo "::warning::Android SDK install incomplete on attempt $attempt/$attempts; discarding partial downloads, retrying in ${delay}s"
    # sdkmanager's download staging (both layouts) and any half-unpacked
    # package directory. A complete package is kept.
    rm -rf "$sdk_root/.temp" "$sdk_root/.downloadIntermediates"
    image_ok || rm -rf "$image_dir"
    emulator_ok || rm -rf "$sdk_root/emulator"
    sleep "$delay"
  fi
done
echo "::error::Android system image or emulator is missing or incomplete after $attempts attempts; emulator tests were not run"
exit 1
