#!/usr/bin/env bash
# Fixture controls for the exact predicate used by the packaged DEB smoke.
# No mock fixture can substitute for the separate real Weston/Electron gate.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ci-linux-wayland-protocol.sh"

fixture="$(mktemp)"
trap 'rm -f "${fixture}"' EXIT

positive_at='[900] wl_registry@2.global(4, "wl_seat", 7)
[901] -> xdg_toplevel@15.set_min_size(520, 400)
[902] -> xdg_surface@14.ack_configure(26)'
positive_hash='[900] wl_registry#2.global(4, "wl_seat", 7)
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
assert_fail '[900] -> xdg_toplevel#15.set_min_size(520, 400)
[901] -> xdg_surface#14.ack_configure(26)' 'missing wl_seat'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_surface#14.ack_configure(26)' 'missing toplevel'
assert_fail '[900] wl_registry#2.global(4, "wl_seat", 7)
[901] -> xdg_toplevel#15.set_min_size(520, 400)' 'missing configure acknowledgement'
assert_fail 'PASS: packaged Bridge opened an X11 window
[901] wl_registry#2.global(4, "wl_seat", 7)' 'X11-only fake success'
assert_fail 'a renderer logged no Wayland protocol objects' 'empty protocol trace'
echo 'PASS: native Wayland acceptance controls (2 valid / 5 invalid / 0 skipped)'
