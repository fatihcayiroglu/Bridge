#!/usr/bin/env bash
# Run inside the disposable Xvfb/dbus session; never reuse a user's desktop.
set -euo pipefail
openbox --sm-disable > "${RUNNER_TEMP}/bridge-perf-window-manager.private.log" 2>&1 &
window_manager_pid=$!
cleanup_window_manager() { kill "${window_manager_pid}" 2>/dev/null || true; }
trap cleanup_window_manager EXIT
for attempt in $(seq 1 50); do
  if ! kill -0 "${window_manager_pid}" 2>/dev/null; then
    echo 'NATIVE_X11_WINDOW_MANAGER_EXITED' >&2
    exit 1
  fi
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id #'; then
    export BRIDGE_PERF_WINDOW_MANAGER='openbox'
    node scripts/perf-acceptance/packaged.mjs "$1"
    exit $?
  fi
  sleep 0.1
done
echo 'NATIVE_X11_WINDOW_MANAGER_NOT_READY' >&2
exit 1
