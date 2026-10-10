#!/usr/bin/env bash
# Reproduction entry point for the NEXT task. Not executed during this handoff.
# Only Chromium, six selected specs, zero retries, maximum 12 minutes + 20s cleanup.
set -euo pipefail
umask 077
handoff_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export BRIDGE_HANDOFF_REPO=$(git -C "$handoff_dir" rev-parse --show-toplevel)
: "${BRIDGE_HANDOFF_RUNTIME:?Run prepare-runtime.sh for a new disposable runtime first}"
: "${PG_TEST_URL:?Set a disposable PostgreSQL database URL}"
: "${REDIS_TEST_URL:?Set an isolated Redis database URL}"
: "${MEDIASOUP_WORKER_BIN:?Set the verified local mediasoup worker path}"
export BRIDGE_HANDOFF_RUNTIME
export BRIDGE_HANDOFF_OUTPUT=$(mktemp -d /tmp/bridge-handoff-chromium.XXXXXX)
export DATABASE_URL="$PG_TEST_URL" REDIS_URL="$REDIS_TEST_URL"
export BRIDGE_UPLOAD_ROOT="$BRIDGE_HANDOFF_OUTPUT/uploads"
export BASE_URL=http://127.0.0.1:3000 MEDIASOUP_WORKERS=1
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"
export no_proxy="$NO_PROXY"
export JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))")"
export REFRESH_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))")"
cd "$BRIDGE_HANDOFF_REPO/e2e"
set +e
timeout --signal=INT --kill-after=20s 12m ./node_modules/.bin/playwright test \
  tests/permission-matrix.spec.ts tests/search-security.spec.ts \
  tests/channel-permissions.spec.ts tests/privacy-lifecycle.spec.ts \
  tests/session-logout.spec.ts tests/attachments.spec.ts \
  --config="$handoff_dir/playwright.config.ts" --project=chromium --retries=0
result=$?
set -e
printf 'Runner exit code: %s; evidence directory: %s\n' "$result" "$BRIDGE_HANDOFF_OUTPUT"
if [ "$result" -eq 124 ] || [ "$result" -eq 137 ]; then
  echo 'INCOMPLETE: bounded runner deadline reached.' >&2
fi
exit "$result"
