#!/usr/bin/env bash
# Start the prebuilt WebDriverAgent in its own bounded step and wait for /status, so the journey's session deadline
# no longer has to cover `xcodebuild test-without-building`. Run 40769336956 started it after 227.9 s and run 40788142507
# after 475.8 s, so the start time is both slow and variable on this runner; here it is bounded, timed and reported.
# Fail-closed: a missing project, an exited process or a timeout fails this step with a distinct code; nothing is skipped.
# The journey then attaches to this agent with appium:webDriverAgentUrl instead of launching its own.
set -euo pipefail
: "${IOS_SIMULATOR_UDID:?IOS_SIMULATOR_UDID required}" "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${WDA_DERIVED_DATA:?WDA_DERIVED_DATA required}"
limit="${WDA_START_LIMIT_SECONDS:-900}"
projects="$(find e2e/ios/node_modules -maxdepth 8 -type d -name WebDriverAgent.xcodeproj 2>/dev/null || true)"
count="$(printf '%s\n' "$projects" | grep -c . || true)"
if [ "$count" != "1" ]; then echo "WDA_START_PROJECT_NOT_UNIQUE count=$count" >&2; exit 1; fi
log="$RUNNER_TEMP/bridge-wda-run.log"
started=$(date +%s)
nohup xcodebuild test-without-building -project "$projects" -scheme WebDriverAgentRunner \
  -destination "id=$IOS_SIMULATOR_UDID" -derivedDataPath "$WDA_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO > "$log" 2>&1 &
pid=$!
echo "$pid" > "$RUNNER_TEMP/bridge-wda.pid"
redacted_tail() { tail -n 40 "$log" | sed -E 's#/Users/runner[^ ]*#<path>#g' >&2; }
while true; do
  elapsed=$(( $(date +%s) - started ))
  if curl -fsS --max-time 3 http://127.0.0.1:8100/status > /dev/null 2>&1; then
    echo "WDA_STARTED seconds=$elapsed"
    echo "WDA_URL=http://127.0.0.1:8100" >> "$GITHUB_ENV"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then echo "WDA_PROCESS_EXITED seconds=$elapsed" >&2; redacted_tail; exit 1; fi
  if [ "$elapsed" -ge "$limit" ]; then
    echo "WDA_START_TIMEOUT seconds=$elapsed limit=$limit" >&2; redacted_tail; kill "$pid" 2>/dev/null || true; exit 1
  fi
  sleep "${WDA_POLL_SECONDS:-5}"
done
