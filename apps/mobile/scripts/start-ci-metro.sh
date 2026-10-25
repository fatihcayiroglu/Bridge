#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root. The real native debug applications depend on
# Metro; a dead packager or expired readiness budget must fail the job.
# Do not dump unfiltered Metro logs: they may contain private fixture data.
mkdir -p apps/mobile/.ci-results
log="apps/mobile/.ci-results/metro.log"
report="apps/mobile/.ci-results/metro-diagnostic.txt"
(
  cd apps/mobile
  # NODE_ENV=test is for JS/JVM tests. Metro is a development packager.
  NODE_ENV=development npm start -- --port 8081
) > "$log" 2>&1 &
metro_pid=$!

record_failure() {
  local reason="$1" status="still-running" category="unclassified"
  if ! kill -0 "$metro_pid" 2>/dev/null; then
    if wait "$metro_pid"; then status=0; else status=$?; fi
  fi
  if grep -Eq 'ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Unable to resolve module' "$log"; then
    category="module-resolution"
  elif grep -Fq 'EADDRINUSE' "$log"; then
    category="port-in-use"
  elif grep -Eq 'SyntaxError|TypeError|ReferenceError' "$log"; then
    category="javascript-error"
  elif grep -Eq 'EMFILE|ENOSPC' "$log"; then
    category="resource-exhaustion"
  elif grep -Eq 'EACCES|EPERM' "$log"; then
    category="permission"
  elif grep -Eq 'error:|Error:|ERROR|ERR_' "$log"; then
    category="other-error"
  fi
  printf 'status=FAIL\nreason=%s\nexit-status=%s\ncategory=%s\n' "$reason" "$status" "$category" | tee "$report" >&2
}

for attempt in {1..90}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:8081/status | grep -qx 'packager-status:running'; then
    printf 'status=PASS\nreason=metro-readiness-confirmed\n' | tee "$report"
    exit 0
  fi
  if ! kill -0 "$metro_pid" 2>/dev/null; then
    record_failure "process-exited-before-ready"
    exit 1
  fi
  sleep 1
done
record_failure "readiness-timeout"
exit 1
