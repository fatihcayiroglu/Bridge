#!/usr/bin/env bash
# CI-only first-run smoke test of the ACTUAL packaged Linux application.
# Must execute within xvfb-run + dbus-run-session, without --no-sandbox.
set -euo pipefail

ELECTRON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${ELECTRON_ROOT}/release/linux-unpacked/bridge"
if [[ ! -x "${APP}" ]]; then
  echo "Packaged Bridge Linux executable missing or not executable: ${APP}" >&2
  exit 1
fi

WORK="$(mktemp -d)"
export XDG_CONFIG_HOME="${WORK}/config"
export XDG_CACHE_HOME="${WORK}/cache"
export XDG_RUNTIME_DIR="${WORK}/runtime"
mkdir -p "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}" "${XDG_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"
LOG="${WORK}/bridge-launch.log"
PID=""
cleanup() {
  if [[ -n "${PID}" ]]; then
    kill "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
  if [[ -s "${LOG}" ]]; then
    echo "===== Packaged Linux startup log ====="
    tail -80 "${LOG}"
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

"${APP}" >"${LOG}" 2>&1 &
PID=$!
for ((i = 0; i < 60; i++)); do
  if ! kill -0 "${PID}" 2>/dev/null; then
    echo "Bridge exited before presenting its first-run window" >&2
    exit 1
  fi
  # xdotool queries the real X server; merely starting a child process does
  # NOT count as a successful GUI smoke. No mock window or injected DOM.
  if xdotool search --onlyvisible --name '^Bridge$' >/dev/null 2>&1; then
    echo "PASS: packaged Bridge opened a visible first-run window on Linux/X11"
    exit 0
  fi
  sleep 1
done
echo "FAIL: packaged Bridge did not show a visible first-run window in 60 seconds" >&2
exit 1
