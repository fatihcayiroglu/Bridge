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
    /xdg_surface[@#][0-9]+\.get_toplevel\(/ {
      s = surf_id($0); t = new_top($0)
      if (s != "" && t != "") {
        if (role[s] != "") delete owner[role[s]]
        role[s] = t; owner[t] = s; delete sized[s]
      }
    }
    /xdg_toplevel[@#][0-9]+\.set_(min|max)_size\(/ {
      t = top_id($0); s = owner[t]
      if (s != "" && role[s] == t) sized[s] = 1
    }
    /xdg_surface[@#][0-9]+\.ack_configure\(/ {
      s = surf_id($0)
      if (s != "" && role[s] != "" && sized[s]) complete = 1
    }
    /xdg_surface[@#][0-9]+\.(destroy|get_popup)\(/ {
      s = surf_id($0)
      if (s != "" && role[s] != "") delete owner[role[s]]
      delete role[s]; delete sized[s]
    }
    /xdg_toplevel[@#][0-9]+\.destroy\(/ {
      t = top_id($0); s = owner[t]
      if (s != "" && role[s] == t) { delete role[s]; delete sized[s] }
      delete owner[t]
    }
    END { exit !complete }
  ' "${log}" 2>/dev/null
}
