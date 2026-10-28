#!/usr/bin/env bash
# Common strict native-Wayland acceptance predicate. Used by the real
# installed-DEB smoke and deterministic protocol regression controls.
# This is not a stand-alone claim that a physical Wayland desktop worked.
wayland_protocol_ready() {
  local protocol_log="${1:?protocol log path required}"
  [[ -r "${protocol_log}" ]] || return 1
  # A role request on surface A and an ACK on surface B do not prove that
  # either toplevel completed configuration. Track the same live object in
  # protocol order. Do not exit early: consuming the file also avoids SIGPIPE.
  awk '
    function surface_id(line, id) {
      match(line, /xdg_surface[@#][0-9]+\./)
      id = substr(line, RSTART, RLENGTH)
      sub(/^xdg_surface[@#]/, "", id)
      sub(/\.$/, "", id)
      return id
    }
    /wl_registry[@#][0-9]+\.global\([0-9]+, "wl_seat", [0-9]+\)/ { seat = 1 }
    /xdg_surface[@#][0-9]+\.get_toplevel\(/ { toplevel[surface_id($0)] = 1 }
    /xdg_surface[@#][0-9]+\.(destroy|get_popup)\(/ { delete toplevel[surface_id($0)] }
    /xdg_surface[@#][0-9]+\.ack_configure\([0-9]+\)/ {
      if (toplevel[surface_id($0)]) configured = 1
    }
    END { exit !(seat && configured) }
  ' "${protocol_log}" 2>/dev/null
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
}
