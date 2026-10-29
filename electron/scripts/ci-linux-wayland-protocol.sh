#!/usr/bin/env bash
# Exact native-Wayland proof: size request and configure ACK belong to one
# currently live xdg_surface / xdg_toplevel pair, in protocol order.
# Shared between the installed-DEB smoke and fixture controls.
wayland_protocol_ready() {
  local log="${1:?protocol log required}"
  [[ -r "${log}" ]] || return 1
  awk '
    function surf_id(line, id) {
      if (!match(line, /xdg_surface[@#][0-9]+\./)) return ""
      id = substr(line, RSTART, RLENGTH)
      sub(/^xdg_surface[@#]/, "", id); sub(/\.$/, "", id)
      return id
    }
    function top_id(line, id) {
      if (!match(line, /xdg_toplevel[@#][0-9]+\./)) return ""
      id = substr(line, RSTART, RLENGTH)
      sub(/^xdg_toplevel[@#]/, "", id); sub(/\.$/, "", id)
      return id
    }
    function new_top(line, id) {
      if (!match(line, /new id xdg_toplevel[@#][0-9]+/)) return ""
      id = substr(line, RSTART, RLENGTH)
      sub(/^new id xdg_toplevel[@#]/, "", id)
      return id
    }
    # A successful ACK is not permanent evidence. Retire the entire proof
    # when its window role or surface is destroyed or reassigned.
    function retire(s, t) {
      if (s == "") return
      t = role[s]
      if (t != "" && owner[t] == s) delete owner[t]
      delete role[s]; delete sized[s]; delete configured[s]
    }
    /xdg_surface[@#][0-9]+\.get_toplevel\(/ {
      s = surf_id($0); t = new_top($0)
      if (s != "" && t != "") {
        if (owner[t] != "" && owner[t] != s) retire(owner[t])
        retire(s)
        role[s] = t; owner[t] = s
      }
    }
    /xdg_toplevel[@#][0-9]+\.set_(min|max)_size\(/ {
      t = top_id($0); s = owner[t]
      if (s != "" && role[s] == t) sized[s] = 1
    }
    /xdg_surface[@#][0-9]+\.ack_configure\(/ {
      s = surf_id($0)
      if (s != "" && role[s] != "" && owner[role[s]] == s && sized[s])
        configured[s] = 1
    }
    /xdg_surface[@#][0-9]+\.(destroy|get_popup)\(/ {
      retire(surf_id($0))
    }
    /xdg_toplevel[@#][0-9]+\.destroy\(/ {
      t = top_id($0); s = owner[t]
      retire(s)
      delete owner[t]
    }
    END {
      for (s in configured)
        if (configured[s] && role[s] != "" && owner[role[s]] == s && sized[s])
          exit 0
      exit 1
    }
  ' "${log}" 2>/dev/null
}

# Emit only fixed metric names and integer counts. Do not copy raw Wayland,
# compositor, GTK, Electron or renderer messages into public CI transcripts.
# The private capture is removed by the smoke script's EXIT trap.
wayland_protocol_summary() {
  local protocol_log="${1:?protocol log required}"
  if [[ ! -r "${protocol_log}" ]]; then
    echo 'wayland-log=unavailable'
    return 0
  fi
  local field pattern count
  while IFS='|' read -r field pattern; do
    count="$(grep -Ec -- "${pattern}" "${protocol_log}" 2>/dev/null || true)"
    printf 'wayland-%s=%s\n' "${field}" "${count:-0}"
  done <<'PATTERNS'
surfaces|wl_compositor[@#][0-9]+\.create_surface
xdg-surfaces|xdg_wm_base[@#][0-9]+\.get_xdg_surface
get-toplevel|xdg_surface[@#][0-9]+\.get_toplevel
size-requests|xdg_toplevel[@#][0-9]+\.set_(min|max)_size\(
configure-acks|xdg_surface[@#][0-9]+\.ack_configure
gtk-seat-assertions|GDK_IS_SEAT
gtk-scale-assertions|GTK_IS_WIDGET
drm-device-errors|drmGetDevices2\(\).*not found any devices
PATTERNS
}
