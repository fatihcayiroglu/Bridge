#!/usr/bin/env bash
# Deterministic parser controls. Real installed-DEB proof runs separately.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ci-linux-wayland-protocol.sh"
fixture="$(mktemp)"
trap 'rm -f "${fixture}"' EXIT
passed=0
refused=0
assert_pass() {
  printf '%s\n' "$1" > "${fixture}"
  if ! wayland_protocol_ready "${fixture}"; then echo "FAIL: valid $2" >&2; exit 1; fi
  passed=$((passed+1))
}
assert_fail() {
  printf '%s\n' "$1" > "${fixture}"
  if wayland_protocol_ready "${fixture}"; then echo "FAIL: invalid $2" >&2; exit 1; fi
  refused=$((refused+1))
}
assert_pass '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)' 'same live surface # IDs'
assert_pass '[1] -> xdg_surface@14.get_toplevel(new id xdg_toplevel@15)
[2] -> xdg_toplevel@15.set_max_size(1024, 768)
[3] -> xdg_surface@14.ack_configure(26)' 'same live surface @ IDs'
assert_pass '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#99.ack_configure(22)
[4] -> xdg_surface#14.ack_configure(26)' 'unrelated ACK then matching ACK'
assert_pass '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_surface#14.destroy()
[3] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#16)
[4] -> xdg_toplevel#16.set_min_size(520, 400)
[5] -> xdg_surface#14.ack_configure(26)' 'valid reuse after role recreation'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)' 'no configure ACK'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_surface#14.ack_configure(26)' 'no size request'
assert_fail '[1] -> xdg_toplevel#15.set_min_size(520, 400)
[2] -> xdg_surface#14.ack_configure(26)' 'no toplevel role'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#99.ack_configure(26)' 'ACK from another surface'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#99.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)' 'size request on another toplevel'
assert_fail '[1] -> xdg_surface#14.ack_configure(26)
[2] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[3] -> xdg_toplevel#15.set_min_size(520, 400)' 'ACK before role'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.destroy()
[4] -> xdg_surface#14.ack_configure(26)' 'destroyed surface'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.get_popup(new id xdg_popup#16, nil, nil)
[4] -> xdg_surface#14.ack_configure(26)' 'popup replaces role'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_toplevel#15.destroy()
[4] -> xdg_surface#14.ack_configure(26)' 'destroyed toplevel'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.destroy()
[4] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#16)
[5] -> xdg_surface#14.ack_configure(26)' 'old size after new role'
assert_fail 'PASS: bridge opened X11 window
🌉 private-server-login' 'spoofed X11'
assert_fail '' 'empty log'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#16)
[4] -> xdg_surface#14.ack_configure(26)' 'superseded role no size'
# Only exit status is used; private renderer text must never enter the report.
printf '%s\n' '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)' '[2] -> xdg_toplevel#15.set_min_size(520, 400)' '[3] -> xdg_surface#14.ack_configure(26)' 'Bearer secret-token private-account' > "${fixture}"
wayland_protocol_ready "${fixture}"
echo "PASS: native Wayland same-surface controls (${passed} valid / ${refused} invalid / 1 privacy / 0 skipped)"
