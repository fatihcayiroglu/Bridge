#!/usr/bin/env bash
# Compile WebDriverAgent for the simulator in its own bounded step, so the journey's 240 s driver deadline measures
# the session and the app, not a cold Xcode build. Runs 40688639373 and 40712701537 hit that deadline while Appium's
# own WDA build was still compiling (xcodebuild "Analyze ... WebDriverAgentLib" lines seconds before the gate).
# Fail-closed: if the project is not found or the build fails, this step fails with a distinct code; nothing is skipped.
set -euo pipefail
: "${IOS_SIMULATOR_UDID:?IOS_SIMULATOR_UDID required}" "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}"
out="${MOBILE_AUTH_EVIDENCE:-mobile-auth-evidence}"; mkdir -p "$out"
projects="$(find e2e/ios/node_modules -maxdepth 8 -type d -name WebDriverAgent.xcodeproj 2>/dev/null || true)"
count="$(printf '%s\n' "$projects" | grep -c . || true)"
if [ "$count" != "1" ]; then echo "WDA_PREBUILD_PROJECT_NOT_UNIQUE count=$count" >&2; exit 1; fi
derived="$RUNNER_TEMP/bridge-wda-derived"
started=$(date +%s)
if ! xcodebuild build-for-testing -project "$projects" -scheme WebDriverAgentRunner \
     -destination "id=$IOS_SIMULATOR_UDID" -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO > "$out/wda-prebuild.log" 2>&1; then
  echo "WDA_PREBUILD_FAILED seconds=$(( $(date +%s) - started ))" >&2
  tail -n 40 "$out/wda-prebuild.log" | sed -E 's#/Users/runner[^ ]*#<path>#g' >&2
  exit 1
fi
echo "WDA_PREBUILD_OK seconds=$(( $(date +%s) - started ))"
echo "WDA_DERIVED_DATA=$derived" >> "$GITHUB_ENV"
