#!/usr/bin/env bash
# Compatibility wrapper. The Node implementation is the canonical,
# cross-platform packager and performs manifest + fresh-extract verification.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/package-release.js" "$@"
