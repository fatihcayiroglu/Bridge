#!/usr/bin/env bash
# e2e/android/select-webview-provider.sh — DIAGNOSTIC ONLY (#209 controlled
# WebView comparison). Runs inside the booted emulator step, BEFORE the
# journeys, and changes exactly one variable: the WebView provider. The OS
# image, Google Play services, emulator options and Bridge APK stay the same.
#
# Installs a Chromium-built SystemWebView (package com.android.webview) and
# selects it with `cmd webviewupdate set-webview-implementation`. A debuggable
# image skips the provider signature check, but the package must still be in
# the image's configured provider list. A refusal is reported and the step
# FAILS: an unavailable comparison is never a pass.
#
# Prints only fixed-form facts: package names, version names and fixed status
# words. No serials, paths or device identifiers.
set -euo pipefail

APK="${WEBVIEW_OVERRIDE_APK:?WEBVIEW_OVERRIDE_APK is required}"
PKG="${WEBVIEW_OVERRIDE_PACKAGE:-com.android.webview}"
case "$PKG" in
  com.android.webview) ;;
  *) echo "WEBVIEW_OVERRIDE status=refused reason=package-not-allowlisted"; exit 2 ;;
esac

adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'

# Read once per call; awk (not head) so no pipe stage dies of SIGPIPE under
# pipefail. adb may end lines with CR.
webview_dump() { adb shell dumpsys webviewupdate | tr -d '\r'; }

# "Current WebView package (name, version): (com.google.android.webview, 113.0.5672.136)"
current_provider() {
  webview_dump \
    | sed -n 's/.*Current WebView package (name, version): (\([A-Za-z0-9_.]*\), \([0-9.]*\)).*/\1@\2/p' \
    | awk 'NR == 1'
}

# The image's configured providers, by package name only: "Valid package X
# (...)", "Invalid package X (...)" or "X is NOT installed." per entry.
configured_providers() {
  webview_dump \
    | sed -n -e 's/^ *Valid package \([A-Za-z0-9_.]*\) .*/\1:valid/p' \
             -e 's/^ *Invalid package \([A-Za-z0-9_.]*\) .*/\1:invalid/p' \
             -e 's/^ *\([A-Za-z0-9_.]*\) is NOT installed\.$/\1:not-installed/p' \
    | awk 'NR <= 16 { printf "%s ", $0 }'
}

echo "WEBVIEW_OVERRIDE before=$(current_provider) debuggable=$(adb shell getprop ro.debuggable | tr -dc '01')"
echo "WEBVIEW_OVERRIDE configured-before=$(configured_providers)"

if ! adb install -r -d "$APK" >/dev/null; then
  echo "WEBVIEW_OVERRIDE status=refused reason=install-failed"
  exit 3
fi
echo "WEBVIEW_OVERRIDE configured-after-install=$(configured_providers)"

# Default WebView flags only: no command-line file left over from an image.
adb shell rm -f /data/local/tmp/webview-command-line || true

adb shell cmd webviewupdate set-webview-implementation "$PKG" >/dev/null 2>&1 || true
selected="$(current_provider)"
if [ "${selected%%@*}" != "$PKG" ]; then
  echo "WEBVIEW_OVERRIDE status=refused reason=provider-not-selectable current=$selected"
  exit 4
fi
echo "WEBVIEW_OVERRIDE status=selected provider=$selected"
