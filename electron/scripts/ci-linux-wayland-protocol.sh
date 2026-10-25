#!/usr/bin/env bash
# Common strict native-Wayland acceptance predicate. Used by the real
# installed-DEB smoke and deterministic protocol regression controls.
# This is not a stand-alone claim that a physical Wayland desktop worked.
wayland_protocol_ready() {
  local protocol_log="${1:?protocol log path required}"
  [[ -r "${protocol_log}" ]] || return 1
  grep -Eq -- 'wl_registry[@#][0-9]+\.global\([0-9]+, "wl_seat", [0-9]+\)' "${protocol_log}" 2>/dev/null &&
    grep -Eq -- 'xdg_surface[@#][0-9]+\.get_toplevel\(' "${protocol_log}" 2>/dev/null &&
    grep -Eq -- 'xdg_surface[@#][0-9]+\.ack_configure\(' "${protocol_log}" 2>/dev/null
}

# Closed counts only: no arbitrary title, renderer text, URL or runner path.
wayland_protocol_summary() {
  local protocol_log="${1:?protocol log path required}"
  if [[ ! -r "${protocol_log}" ]]; then
    echo 'wayland-log=unavailable'
    return 0
  fi
  local field pattern count
  while IFS='|' read -r field pattern; do
    count=$(grep -Ec -- "${pattern}" "${protocol_log}" 2>/dev/null || true)
    count="${count:-unavailable}"
    printf 'wayland-%s=%s\n' "${field}" "${count}"
  done <<'PATTERNS'
seat-globals|wl_registry[@#][0-9]+\.global\([0-9]+, "wl_seat", [0-9]+\)
surfaces|wl_compositor[@#][0-9]+\.create_surface
xdg-surfaces|xdg_wm_base[@#][0-9]+\.get_xdg_surface
get-toplevel|xdg_surface[@#][0-9]+\.get_toplevel
configure-acks|xdg_surface[@#][0-9]+\.ack_configure
seat-keyboards|wl_seat[@#][0-9]+\.get_keyboard
app-ready|🌉
drm-device-errors|drmGetDevices2\(\).*not found any devices
PATTERNS
  # Only the opt-in application's finite numeric stage codes leave the log.
  # Preserve observation order; never copy surrounding text or unknown values.
  grep -Eo 'BRIDGE_NATIVE_STAGE=(1[0-2]|[1-9])([[:space:]]|$)' "${protocol_log}" 2>/dev/null |
    sed -n '1,20{s/[^0-9]//g;s/^/native-startup-stage=/;p;}' || true
}
