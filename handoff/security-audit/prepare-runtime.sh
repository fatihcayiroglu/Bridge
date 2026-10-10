#!/usr/bin/env bash
# Future Codex task only: build the committed audit source in a disposable copy.
set -euo pipefail
handoff_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$handoff_dir" rev-parse --show-toplevel)
: "${BRIDGE_HANDOFF_RUNTIME:?Set an absolute NEW disposable runtime directory}"
case "$BRIDGE_HANDOFF_RUNTIME" in /*) ;; *) echo 'Runtime path must be absolute' >&2; exit 1;; esac
[ ! -e "$BRIDGE_HANDOFF_RUNTIME" ] || { echo 'Refusing to overwrite an existing runtime' >&2; exit 1; }
[ "$(node --version)" = v24.20.0 ] || { echo 'Activate Node 24.20.0 first' >&2; exit 1; }
[ -d "$repo/node_modules" ] && [ -d "$repo/server/node_modules" ] || { echo 'Run frozen-lockfile installs first' >&2; exit 1; }
bash "$handoff_dir/verify-handoff.sh"
mkdir -p "$BRIDGE_HANDOFF_RUNTIME"
git -C "$repo" archive 8e10f51b7c60bab533edad4373414002caae4a7a | tar -xf - -C "$BRIDGE_HANDOFF_RUNTIME"
cp -a "$repo/node_modules" "$BRIDGE_HANDOFF_RUNTIME/node_modules"
cp -a "$repo/server/node_modules" "$BRIDGE_HANDOFF_RUNTIME/server/node_modules"
(cd "$BRIDGE_HANDOFF_RUNTIME" && npm run build)
(cd "$BRIDGE_HANDOFF_RUNTIME/server" && npm run build)
