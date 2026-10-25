#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. Only disposable CI databases are configured by
# the workflow. Liveness is served by Bridge itself, never a fixture HTTP server.
mkdir -p apps/mobile/.ci-results
git rev-parse HEAD > apps/mobile/.ci-results/source-commit.txt
node server/dist/index.js > apps/mobile/.ci-results/bridge.log 2>&1 &
echo "$!" > apps/mobile/.ci-results/bridge.pid
for attempt in {1..60}; do
  if curl --silent --fail http://127.0.0.1:3000/api/health/ready >/dev/null; then
    curl --fail --silent http://127.0.0.1:3000/api/health/live
    exit 0
  fi
  kill -0 "$(cat apps/mobile/.ci-results/bridge.pid)"
  sleep 2
done
echo 'Real Bridge backend did not become ready' >&2
exit 1
