#!/usr/bin/env bash
# Common strict native-Wayland acceptance predicate. Used by the real
# installed-DEB smoke and deterministic protocol regression controls.
# This is not a stand-alone claim that a physical Wayland desktop worked.
wayland_protocol_ready() {
  local protocol_log="${1:?protocol log path required}"
  [[ -r "${protocol_log}" ]] || return 1
  grep -Eq -- 'wl_registry[@#][0-9]+\.global\([0-9]+, "wl_seat", [0-9]+\)' "${protocol_log}" &&
    grep -Eq -- 'xdg_toplevel[@#][0-9]+\.set_(min|max)_size\(' "${protocol_log}" &&
    grep -Eq -- 'xdg_surface[@#][0-9]+\.ack_configure\(' "${protocol_log}"
}
