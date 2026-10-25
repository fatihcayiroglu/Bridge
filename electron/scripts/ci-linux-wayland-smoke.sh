#!/usr/bin/env bash
# Native Wayland smoke: start the INSTALLED Bridge DEB in real Weston.
# Weston 13 headless lacks wl_seat; nest Weston under CI Xvfb for input.
# The installed Electron process never receives DISPLAY; Wayland is mandatory.
# No --no-sandbox, no fake Electron window, no XWayland fallback.
# This is HEADLESS compositor evidence, not a physical desktop UX test.
set -euo pipefail

APP=/opt/Bridge/bridge
test -x "${APP}" || { echo "Missing installed DEB executable" >&2; exit 1; }
command -v weston >/dev/null || { echo "Weston is not installed" >&2; exit 1; }
[[ -n "${DISPLAY:-}" ]] || { echo "Nested Weston needs Xvfb DISPLAY (compositor only)" >&2; exit 1; }

ROOT="$(mktemp -d)"
COMPOSITOR_PID=""
APP_PID=""
cleanup() {
  [[ -z "${APP_PID}" ]] || { kill "${APP_PID}" 2>/dev/null || true; wait "${APP_PID}" 2>/dev/null || true; }
  [[ -z "${COMPOSITOR_PID}" ]] || { kill "${COMPOSITOR_PID}" 2>/dev/null || true; wait "${COMPOSITOR_PID}" 2>/dev/null || true; }
  if [[ -f "${ROOT}/app.log" ]]; then
    echo "Wayland protocol surface evidence:"
    grep -E -- 'xdg_surface@[0-9]+\.get_toplevel|xdg_toplevel@[0-9]+\.set_title' "${ROOT}/app.log" | head -8 || true
  fi
  rm -rf "${ROOT}"
}
trap cleanup EXIT

export XDG_RUNTIME_DIR="${ROOT}/runtime"
export XDG_CONFIG_HOME="${ROOT}/config"
export XDG_CACHE_HOME="${ROOT}/cache"
export XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=bridge-wayland
export WAYLAND_DEBUG=client
unset DISPLAY
mkdir -p "${XDG_RUNTIME_DIR}" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"
chmod 700 "${XDG_RUNTIME_DIR}"
weston --backend=x11-backend.so --renderer=pixman --width=1280 --height=800 \
  --socket="${WAYLAND_DISPLAY}" --idle-time=0 --log="${ROOT}/weston.log" >/dev/null 2>&1 &
COMPOSITOR_PID=$!
for i in {1..40}; do
  if ! kill -0 "${COMPOSITOR_PID}" 2>/dev/null; then
    echo "Weston failed to start:" >&2
    tail -60 "${ROOT}/weston.log" >&2 || true
    exit 1
  fi
  [[ -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]] && break
  sleep 0.25
done
[[ -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]] || { echo "Weston Wayland socket missing" >&2; exit 1; }

# All state is isolated. Xvfb is only available to Weston, never Bridge.
# DEB post-install configures the OS Chromium sandbox; do not disable it.
unset DISPLAY
export GDK_BACKEND=wayland
"${APP}" --ozone-platform=wayland --user-data-dir="${ROOT}/profile" >"${ROOT}/app.log" 2>&1 &
APP_PID=$!
for i in {1..60}; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    echo "Packaged Bridge exited before creating a Wayland toplevel" >&2
    tail -40 "${ROOT}/app.log" >&2 || true
    exit 1
  fi
  # Weston 13 shows mixed @/# object ID styles in WAYLAND_DEBUG.
  # Do not require optional xdg_toplevel size hints: a genuine top-level
  # role and compositor configure ACK are mandatory protocol evidence.
  if grep -Eq -- 'wl_registry[@#][0-9]+\.global\([^)]*"wl_seat"' "${ROOT}/app.log" \
    && grep -Eq -- 'xdg_surface[@#][0-9]+\.get_toplevel\(' "${ROOT}/app.log" \
    && grep -Eq -- 'xdg_surface[@#][0-9]+\.ack_configure\(' "${ROOT}/app.log"; then
    echo "PASS: installed Bridge created a native Wayland xdg-toplevel with wl_seat and configure ACK; sandbox enabled; DISPLAY unset"
    exit 0
  fi
  sleep 1
done
echo "FAIL: packaged Bridge did not create a Wayland xdg-toplevel surface in 60s" >&2
tail -60 "${ROOT}/app.log" >&2 || true
exit 1
