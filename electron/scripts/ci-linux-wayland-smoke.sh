#!/usr/bin/env bash
# Native Wayland smoke: launch the INSTALLED Bridge DEB inside Weston nested
# on an isolated Xvfb server. Weston X11-backend supplies a real input seat;
# Bridge itself has NO DISPLAY and talks to Weston using native Wayland only.
# No --no-sandbox, fake Electron window, or XWayland client fallback.
# This is CI virtual-compositor evidence, not physical Linux desktop UX.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ci-linux-wayland-protocol.sh"

APP=/opt/Bridge/bridge
test -x "${APP}" || { echo "Missing installed DEB executable" >&2; exit 1; }
command -v weston >/dev/null || { echo "Weston is not installed" >&2; exit 1; }
[[ -n "${DISPLAY:-}" ]] || { echo "An isolated Xvfb DISPLAY is required for the Weston X11 backend" >&2; exit 1; }

ROOT="$(mktemp -d)"
COMPOSITOR_PID=""
APP_PID=""
cleanup() {
  [[ -z "${APP_PID}" ]] || { kill "${APP_PID}" 2>/dev/null || true; wait "${APP_PID}" 2>/dev/null || true; }
  [[ -z "${COMPOSITOR_PID}" ]] || { kill "${COMPOSITOR_PID}" 2>/dev/null || true; wait "${COMPOSITOR_PID}" 2>/dev/null || true; }
  if [[ -f "${ROOT}/app.log" ]]; then
    echo "Wayland protocol surface evidence:"
    # WAYLAND_DEBUG may format object identities as #N or @N. Only print
    # protocol events, never renderer payloads, app state or bearer tokens.
    grep -E -- 'xdg_(wm_base|surface|toplevel)[@#][0-9]+\.(get_xdg_surface|get_toplevel|ack_configure|set_title|set_(min|max)_size)' "${ROOT}/app.log" | head -12 || true
    # Diagnostic counts never change the native smoke's pass criteria.
    for pattern in \
      'wl_registry[@#][0-9]+\.global\([0-9]+, "wl_seat", [0-9]+\)' \
      'wl_compositor[@#][0-9]+\.create_surface' \
      'xdg_wm_base[@#][0-9]+\.get_xdg_surface' \
      'xdg_surface[@#][0-9]+\.get_toplevel' \
      'xdg_surface[@#][0-9]+\.ack_configure'; do
      count=$(grep -Ec -- "${pattern}" "${ROOT}/app.log" || true)
      echo "Wayland protocol event count: ${pattern} = ${count}"
    done
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
# Preserve DISPLAY only for the compositor child; remove it for Bridge itself.
mkdir -p "${XDG_RUNTIME_DIR}" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"
chmod 700 "${XDG_RUNTIME_DIR}"
weston --backend=x11-backend.so --renderer=pixman --output-count=1 --width=1024 --height=768 --socket="${WAYLAND_DISPLAY}" --idle-time=0 --log="${ROOT}/weston.log" >/dev/null 2>&1 &
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

# Xvfb remains accessible to Weston only. Electron must have no X11 display.
unset DISPLAY
[[ -z "${DISPLAY+x}" ]] || { echo "DISPLAY unexpectedly available to Bridge" >&2; exit 1; }

# All state is isolated. The DEB post-install supplies Chromium sandbox setup.
# Do not relax the sandbox, impersonate root or allow a fallback to X11.
"${APP}" --ozone-platform=wayland --user-data-dir="${ROOT}/profile" >"${ROOT}/app.log" 2>&1 &
APP_PID=$!
for i in {1..60}; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    echo "Packaged Bridge exited before creating a Wayland toplevel" >&2
    echo "No Wayland top-level: bounded protocol evidence follows at cleanup" >&2
    exit 1
  fi
  # Require a real input seat (absent in Weston 13 headless mode), the
  # xdg-toplevel size request, and a compositor configure acknowledgment.
  # WAYLAND_DEBUG uses either #N or @N object IDs, depending on build.
  if wayland_protocol_ready "${ROOT}/app.log"; then
    echo "PASS: installed Bridge created a real native Wayland xdg-toplevel with a wl_seat, configure ack, sandbox on, X11 DISPLAY unset"
    exit 0
  fi
  sleep 1
done
echo "FAIL: packaged Bridge did not create a seated Wayland xdg-toplevel and configure ack in 60s" >&2
# Never dump arbitrary renderer output: it could include personal app metadata.
grep -E -- "(fatal|failed|error)" "${ROOT}/weston.log" | head -10 >&2 || true
exit 1
