#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. Only disposable CI databases are configured by
# the workflow. Liveness is served by Bridge itself, never a fixture HTTP server.
mkdir -p apps/mobile/.ci-results
git rev-parse HEAD > apps/mobile/.ci-results/source-commit.txt
node server/dist/index.js > apps/mobile/.ci-results/bridge.log 2>&1 &
backend_pid=$!
echo "$backend_pid" > apps/mobile/.ci-results/bridge.pid

# A failed process is a test failure, not a reason to retry or extend the
# deadline. Report only bounded, preclassified diagnostics: raw server logs
# can contain private fixture data and must not be copied to public artifacts.
report_backend_failure() {
  local reason="$1"
  local exit_status="still-running"
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    if wait "$backend_pid"; then exit_status=0; else exit_status=$?; fi
  fi
  echo "P8 backend startup FAIL: $reason (exit status: $exit_status)" >&2

  local log="apps/mobile/.ci-results/bridge.log"
  local category="unclassified"
  if grep -Eq 'ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND' "$log"; then
    category="module-resolution"
  elif grep -Fq 'EADDRINUSE' "$log"; then
    category="port-in-use"
  elif grep -Eq 'ECONNREFUSED|Connection refused' "$log"; then
    category="dependency-connection"
  elif grep -Eq 'SQLSTATE|PostgresError|DatabaseError' "$log"; then
    category="database"
  elif grep -Eq 'ENOTFOUND|EAI_AGAIN' "$log"; then
    category="dns"
  fi
  echo "P8 backend startup error category: $category" >&2
  echo 'P8 backend startup allowlisted event names (last 8):' >&2
  grep -oE '"event":"(db[.][a-z._-]+|server[.][a-z._-]+|startup[.][a-z._-]+|redis[.][a-z._-]+)"' "$log" | tail -n 8 >&2 || true
}
for attempt in {1..60}; do
  if curl --silent --fail http://127.0.0.1:3000/api/health/ready >/dev/null; then
    curl --fail --silent http://127.0.0.1:3000/api/health/live
    exit 0
  fi
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    report_backend_failure "process-exited-before-ready"
    exit 1
  fi
  sleep 2
done
report_backend_failure "readiness-timeout"
exit 1
