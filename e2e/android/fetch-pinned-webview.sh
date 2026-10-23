#!/usr/bin/env bash
# e2e/android/fetch-pinned-webview.sh OUT_DIR — DIAGNOSTIC ONLY (#209 controlled
# WebView comparison). Downloads the pinned build of the Chromium project's
# continuous (snapshot) builder named by WEBVIEW_SNAPSHOT_URL (not a release
# channel), verifies the archive and the extracted SystemWebView.apk against
# the pinned SHA-256 values, and prints the APK's aapt2 badging facts: package,
# version, min/target SDK and ABIs. Any mismatch fails before an install.
#
# Prints only fixed status lines and the badging lines above: no paths or URLs.
set -euo pipefail

OUT="${1:?output directory required}"
URL="${WEBVIEW_SNAPSHOT_URL:?WEBVIEW_SNAPSHOT_URL is required}"
ZIP_SHA="${WEBVIEW_SNAPSHOT_SHA256:?WEBVIEW_SNAPSHOT_SHA256 is required}"
APK_SHA="${WEBVIEW_APK_SHA256:?WEBVIEW_APK_SHA256 is required}"
SDK="${ANDROID_HOME:?ANDROID_HOME is required}"
# Exactly one archive shape from the snapshot bucket: a typo guard; the pinned
# hashes below are what identify the file.
if ! [[ "$URL" =~ ^https://commondatastorage\.googleapis\.com/chromium-browser-snapshots/AndroidDesktop_x64/[0-9]{1,12}/chrome-android-desktop\.zip$ ]]; then
  echo "::error::WebView snapshot must be an AndroidDesktop_x64 chrome-android-desktop.zip from the Chromium snapshot bucket"
  exit 2
fi

mkdir -p "$OUT"
zip="$OUT/snapshot.zip"
# A network retry for the download only; nothing here retries a test.
if ! curl -fsSL --retry 2 --retry-delay 5 -o "$zip" "$URL" 2>/dev/null; then
  echo "WEBVIEW_FETCH status=failed reason=download-failed"
  exit 3
fi
if ! echo "$ZIP_SHA  $zip" | sha256sum --status -c - 2>/dev/null; then
  echo "WEBVIEW_FETCH status=failed reason=zip-sha256-mismatch"
  exit 4
fi
echo "WEBVIEW_FETCH zip-sha256=ok"
if ! unzip -q -o -j "$zip" chrome-android-desktop/apks/SystemWebView.apk -d "$OUT" >/dev/null 2>&1; then
  echo "WEBVIEW_FETCH status=failed reason=apk-not-in-archive"
  exit 5
fi
rm -f "$zip"
if ! echo "$APK_SHA  $OUT/SystemWebView.apk" | sha256sum --status -c - 2>/dev/null; then
  echo "WEBVIEW_FETCH status=failed reason=apk-sha256-mismatch"
  exit 4
fi
echo "WEBVIEW_FETCH apk-sha256=ok"

aapt2="$( { find "$SDK/build-tools" -name aapt2 -type f 2>/dev/null || true; } | sort -V | tail -n 1)"
if [ -z "$aapt2" ]; then
  echo "WEBVIEW_FETCH status=failed reason=aapt2-not-found"
  exit 6
fi
# aapt2 prints minSdkVersion:'N' (not aapt1's sdkVersion:) and, for a
# multi-ABI APK, the primary ABI as native-code: and the others as
# alt-native-code:.
if ! badging="$("$aapt2" dump badging "$OUT/SystemWebView.apk" 2>/dev/null)"; then
  echo "WEBVIEW_FETCH status=failed reason=badging-unreadable"
  exit 7
fi
printf '%s\n' "$badging" \
  | { grep -E "^(package:|minSdkVersion:|targetSdkVersion:|native-code:|alt-native-code:)" || true; } \
  | sed -E "s/ (compileSdkVersion|compileSdkVersionCodename|platformBuildVersionName|platformBuildVersionCode)='[^']*'//g"
