#!/usr/bin/env bash
# Native Wayland smoke: start the INSTALLED Bridge DEB in a real Weston
# compositor. Assert that Chromium creates an xdg-toplevel Wayland surface.
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

# Bounded, redacted diagnostics for issue #416 (intermittent missing xdg_toplevel). They only PRINT facts; no check below
# is relaxed, the 60 s limit, the native-Wayland flags and the sandbox stay exactly as they were.
print_compositor_facts() {
  echo "WAYLAND_DIAG weston=$(weston --version 2>&1 | head -1 | tr -cd '[:print:]' | cut -c1-60)"
  if command -v wayland-info >/dev/null 2>&1; then
    # Captured once: `grep -q` on a pipe would SIGPIPE wayland-info and, under pipefail, report a present seat as absent.
    # Run 40779869140 printed an empty global list from a too-strict pattern, so the raw head is printed as well.
    local info status=0
    info="$(wayland-info 2>&1)" || status=$?
    echo "WAYLAND_DIAG wayland-info exit=${status} lines=$(printf '%s\n' "${info}" | grep -c . || true)"
    # Interface names only; tolerate any spacing or tabs between the fields.
    echo "WAYLAND_DIAG globals=$(grep -oE "interface:[[:space:]]*'[a-z_0-9]+'" <<<"${info}" | sed -E "s/interface:[[:space:]]*'([a-z_0-9]+)'/\1/" | sort -u | tr '\n' ' ' | cut -c1-600)"
    if grep -qE "interface:[[:space:]]*'wl_seat'" <<<"${info}"; then echo "WAYLAND_DIAG wl_seat=present"; else echo "WAYLAND_DIAG wl_seat=ABSENT"; fi
    echo "WAYLAND_DIAG wayland-info head:"
    printf '%s\n' "${info}" | head -40 | tr -cd '[:print:]\n\t' | cut -c1-140
  else
    echo "WAYLAND_DIAG wayland-info=not-installed"
  fi
}
print_failure_facts() {
  local app_alive=no comp_alive=no
  kill -0 "${APP_PID}" 2>/dev/null && app_alive=yes
  kill -0 "${COMPOSITOR_PID}" 2>/dev/null && comp_alive=yes
  echo "WAYLAND_DIAG failure app_alive=${app_alive} compositor_alive=${comp_alive}"
  if [[ -f "${ROOT}/app.log" ]]; then
    echo "WAYLAND_DIAG app_log gdk_seat_assertions=$(grep -c 'GDK_IS_SEAT' "${ROOT}/app.log" || true)" \
      "bind_wl_seat=$(grep -Ec 'wl_registry#[0-9]+\.bind\([0-9]+, "wl_seat"' "${ROOT}/app.log" || true)" \
      "get_xdg_surface=$(grep -Ec 'xdg_wm_base#[0-9]+\.get_xdg_surface' "${ROOT}/app.log" || true)" \
      "get_toplevel=$(grep -Ec 'xdg_surface#[0-9]+\.get_toplevel' "${ROOT}/app.log" || true)" \
      "ack_configure=$(grep -Ec 'xdg_surface#[0-9]+\.ack_configure' "${ROOT}/app.log" || true)" \
      "set_min_max_size=$(grep -Ec 'xdg_toplevel#[0-9]+\.set_(min|max)_size' "${ROOT}/app.log" || true)"
  fi
  if [[ -f "${ROOT}/weston.log" ]]; then
    echo "WAYLAND_DIAG weston.log tail (compositor start-up and client events, no user data):"
    tail -30 "${ROOT}/weston.log" | cut -c1-240 || true
  fi
}

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
WAYLAND_DEBUG= print_compositor_facts

# All state is isolated. The DEB post-install supplies Chromium sandbox setup.
# Do not relax the sandbox, impersonate root or allow a fallback to X11.
"${APP}" --ozone-platform=wayland --user-data-dir="${ROOT}/profile" >"${ROOT}/app.log" 2>&1 &
APP_PID=$!
for i in {1..60}; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    echo "Packaged Bridge exited before creating a Wayland toplevel" >&2
    print_failure_facts >&2
    tail -40 "${ROOT}/app.log" >&2 || true
    exit 1
  fi
  # Weston 13 / Wayland debug prints protocol object IDs as #23, not @23.
  # Require the top-level window's real size request AND its compositor
  # configure acknowledgement. Neither can come from a mocked process.
  if grep -Eq -- 'xdg_toplevel#[0-9]+\.set_(min|max)_size\(' "${ROOT}/app.log" \
    && grep -Eq -- 'xdg_surface#[0-9]+\.ack_configure\(' "${ROOT}/app.log"; then
    echo "PASS: installed Bridge created a real xdg-toplevel surface on headless Weston/Wayland, sandbox enabled, X11 DISPLAY unset"
    exit 0
  fi
  sleep 1
done
echo "FAIL: packaged Bridge did not create a Wayland xdg-toplevel surface in 60s" >&2
print_failure_facts >&2
tail -60 "${ROOT}/app.log" >&2 || true
exit 1
