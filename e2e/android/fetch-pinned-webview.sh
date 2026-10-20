#!/usr/bin/env bash
# e2e/android/fetch-pinned-webview.sh OUT_DIR — DIAGNOSTIC ONLY (#209 controlled
# WebView comparison). Downloads the pinned official Chromium continuous build
# named by WEBVIEW_SNAPSHOT_URL, verifies the archive and the extracted
# SystemWebView.apk against the pinned SHA-256 values, and prints the APK's
# package, version, SDK and ABI facts. Any mismatch fails before an install.
set -euo pipefail

OUT="${1:?output directory required}"
URL="${WEBVIEW_SNAPSHOT_URL:?WEBVIEW_SNAPSHOT_URL is required}"
ZIP_SHA="${WEBVIEW_SNAPSHOT_SHA256:?WEBVIEW_SNAPSHOT_SHA256 is required}"
APK_SHA="${WEBVIEW_APK_SHA256:?WEBVIEW_APK_SHA256 is required}"
case "$URL" in
  https://commondatastorage.googleapis.com/chromium-browser-snapshots/*) ;;
  *) echo "::error::WebView snapshot must come from the Chromium snapshot bucket"; exit 2 ;;
esac

mkdir -p "$OUT"
zip="$OUT/snapshot.zip"
# A network retry for the download only; nothing here retries a test.
curl -fsSL --retry 2 --retry-delay 5 -o "$zip" "$URL"
echo "$ZIP_SHA  $zip" | sha256sum -c -
unzip -q -o -j "$zip" chrome-android-desktop/apks/SystemWebView.apk -d "$OUT"
rm -f "$zip"
echo "$APK_SHA  $OUT/SystemWebView.apk" | sha256sum -c -

aapt2="$(find "${ANDROID_HOME:?ANDROID_HOME is required}/build-tools" -name aapt2 -type f | sort -V | tail -n 1)"
test -n "$aapt2"
"$aapt2" dump badging "$OUT/SystemWebView.apk" \
  | grep -E "^(package:|sdkVersion:|targetSdkVersion:|native-code:)" \
  | sed -E "s/ (compileSdkVersion|compileSdkVersionCodename|platformBuildVersionName|platformBuildVersionCode)='[^']*'//g"
