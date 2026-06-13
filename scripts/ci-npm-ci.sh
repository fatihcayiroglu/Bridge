#!/usr/bin/env bash
set -Eeuo pipefail

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "Dir:  $(pwd)"

export npm_config_audit=false
export npm_config_fund=false
export npm_config_update_notifier=false
export npm_config_progress=false

echo "Running npm ci..."
if npm ci --no-audit --no-fund "$@"; then
  exit 0
fi

echo "::warning::npm ci failed once. Verifying/cleaning npm cache and retrying..."
npm cache verify || true
npm cache clean --force || true

npm ci --no-audit --no-fund "$@"
