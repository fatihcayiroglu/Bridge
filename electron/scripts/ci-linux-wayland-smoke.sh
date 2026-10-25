#!/usr/bin/env bash
# Native Wayland smoke: installed Bridge DEB must create a real xdg-toplevel
# under headless Weston. GPU-less CI uses Chromium software GL only.
# No --no-sandbox, no fake Electron window, no XWayland fallback.
# This is HEADLESS compositor evidence, not a physical desktop UX test.
set -euo pipefail

APP=/opt/Bridge/bridge
test -x "${APP}" || { echo "Missing installed DEB executable" >&2; exit 1; }
command -v weston >/dev/null || { echo "Weston is not installed" >&2; exit 1; }

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
weston --backend=headless-backend.so --socket="${WAYLAND_DISPLAY}" --idle-time=0 --log="${ROOT}/weston.log" >/dev/null 2>&1 &
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

# All state is isolated. The DEB post-install supplies Chromium sandbox setup.
# Do not relax the sandbox, impersonate root or allow a fallback to X11.
# This runner has no DRM render node. Use Chromium-owned software GLES
# solely for the Wayland CI smoke, not as a shipped application default.
# Native Ozone/Wayland, real compositor, OS sandbox and xdg-shell assertions
# remain required; this is NOT --ozone-platform=headless or --no-sandbox.
"${APP}" --ozone-platform=wayland --use-gl=angle --use-angle=swiftshader \
  --user-data-dir="${ROOT}/profile" >"${ROOT}/app.log" 2>&1 &
APP_PID=$!
for i in {1..60}; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    echo "Packaged Bridge exited before creating a Wayland toplevel" >&2
    tail -40 "${ROOT}/app.log" >&2 || true
    exit 1
  fi
  # Require an actual xdg-shell toplevel role and configure acknowledgment.
  # Size hints are optional in xdg-shell; process existence alone is not PASS.
  if grep -Eq -- 'xdg_surface[@#][0-9]+\.get_toplevel\(' "${ROOT}/app.log" \
    && grep -Eq -- 'xdg_surface[@#][0-9]+\.ack_configure\(' "${ROOT}/app.log"; then
    echo "PASS: installed Bridge created and configured native Wayland xdg-toplevel on GPU-less Weston; OS sandbox enabled, X11 DISPLAY unset"
    exit 0
  fi
  sleep 1
done
echo "FAIL: packaged Bridge did not create a Wayland xdg-toplevel surface in 60s" >&2
tail -60 "${ROOT}/app.log" >&2 || true
exit 1
