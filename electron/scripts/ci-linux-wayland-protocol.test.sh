#!/usr/bin/env bash
# Fixture controls for the exact predicate used by the packaged DEB smoke.
# No mock fixture can substitute for the separate real Weston/Electron gate.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ci-linux-wayland-protocol.sh"

fixture="$(mktemp)"
trap 'rm -f "${fixture}"' EXIT

positive_at='[900] wl_registry@2.global(4, "wl_seat", 7)
[900] -> xdg_surface@14.get_toplevel(new id xdg_toplevel@15)
[901] -> xdg_toplevel@15.set_min_size(520, 400)
[902] -> xdg_surface@14.ack_configure(26)'
positive_hash='[900] wl_registry#2.global(4, "wl_seat", 7)
[900] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[901] -> xdg_toplevel#15.set_max_size(1024, 768)
[902] -> xdg_surface#14.ack_configure(26)'

assert_pass() {
  printf '%s\n' "$1" > "${fixture}"
  if ! wayland_protocol_ready "${fixture}"; then
    echo "FAIL: valid ${2} native protocol rejected" >&2
    exit 1
  fi
}
assert_fail() {
  printf '%s\n' "$1" > "${fixture}"
  if wayland_protocol_ready "${fixture}"; then
    echo "FAIL: invalid ${2} protocol accepted" >&2
    exit 1
  fi
}

assert_pass "${positive_at}" '@-object notation'
assert_pass "${positive_hash}" '#-object notation'
assert_pass '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[902] -> xdg_surface#14.ack_configure(26)' 'actual toplevel without optional size hints'
assert_fail '[900] -> xdg_toplevel#15.set_min_size(520, 400)
[900] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[901] -> xdg_surface#14.ack_configure(26)' 'missing wl_seat'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.ack_configure(26)' 'missing toplevel'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[900] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[901] -> xdg_toplevel#15.set_min_size(520, 400)' 'missing configure acknowledgement'
assert_fail 'PASS: packaged Bridge opened an X11 window
[901] wl_registry#2.global(4, "wl_seat", 7)' 'X11-only fake success'
assert_fail 'a renderer logged no Wayland protocol objects' 'empty protocol trace'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_toplevel#15.set_min_size(520, 400)
[902] -> xdg_surface#14.ack_configure(26)' 'size hints without actual role request'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.get_popup(new id xdg_popup#15, nil, nil)
[902] -> xdg_surface#14.ack_configure(26)' 'popup is not a toplevel'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[902] -> xdg_surface#99.ack_configure(26)' 'configure acknowledgement belongs to another surface'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.ack_configure(26)
[902] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)' 'acknowledgement precedes role creation'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[902] -> xdg_surface#14.destroy()
[903] -> xdg_surface#14.ack_configure(26)' 'destroyed surface cannot acknowledge its old role'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[902] -> xdg_surface#14.destroy()
[903] -> xdg_surface#14.get_popup(new id xdg_popup#16, nil, nil)
[904] -> xdg_surface#14.ack_configure(26)' 'reused surface id has only a popup role'
assert_pass '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#99.ack_configure(25)
[902] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[903] -> xdg_surface#14.ack_configure(26)' 'unrelated earlier acknowledgement does not hide a valid role'
assert_pass '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[902] -> xdg_surface#14.destroy()
[903] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#16)
[904] -> xdg_surface#14.ack_configure(26)' 'reused surface id needs a new toplevel role'
printf '%s\n' "${positive_at}" '🌉 private-account' \
  'private-title /home/private-runner/file.txt https://private-server/ Bearer secret-token' > "${fixture}"
summary=$(wayland_protocol_summary "${fixture}")
[[ "${summary}" == *'wayland-get-toplevel=1'* ]]
[[ "${summary}" == *'wayland-configure-acks=1'* ]]
[[ "${summary}" != *'private'* && "${summary}" != *'secret'* && "${summary}" != *'https://'* && "${summary}" != *'/home/'* ]]
echo 'PASS: native Wayland acceptance controls (5 valid / 11 invalid / 1 privacy / 0 skipped)'
