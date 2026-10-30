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
# A successful ACK must still belong to a live toplevel at the end of
# the captured protocol. A historical success on a destroyed window is not
# acceptable evidence of the currently visible application.
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)
[4] -> xdg_surface#14.destroy()' 'configured surface was subsequently destroyed'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)
[4] -> xdg_toplevel#15.destroy()' 'configured toplevel was subsequently destroyed'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)
[4] -> xdg_surface#14.get_popup(new id xdg_popup#16, nil, nil)' 'configured role replaced by popup'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)
[4] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#16)' 'configured role superseded without a fresh ACK'
assert_fail '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)
[4] -> xdg_surface#99.get_toplevel(new id xdg_toplevel#15)' 'same toplevel object id cannot keep stale surface proof'
assert_pass '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)
[4] -> xdg_surface#99.get_toplevel(new id xdg_toplevel#16)
[5] -> xdg_surface#99.destroy()' 'destroying unrelated surface leaves live proof'
assert_pass '[1] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)
[2] -> xdg_toplevel#15.set_min_size(520, 400)
[3] -> xdg_surface#14.ack_configure(26)
[4] -> xdg_surface#99.get_toplevel(new id xdg_toplevel#16)
[5] -> xdg_toplevel#16.set_max_size(1024, 768)
[6] -> xdg_surface#99.ack_configure(27)
[7] -> xdg_surface#14.destroy()' 'another currently configured toplevel remains live'
# A failed native launch can contain untrusted app/Wayland/GTK text.
# Diagnostic output must retain fixed numerical evidence but never the text.
printf '%s\n' \
  '[1] -> wl_compositor#4.create_surface(new id wl_surface#3)' \
  '[2] -> xdg_wm_base#7.get_xdg_surface(new id xdg_surface#14, wl_surface#3)' \
  '[3] -> xdg_surface#14.get_toplevel(new id xdg_toplevel#15)' \
  '[4] -> xdg_toplevel#15.set_min_size(520, 400)' \
  '[5] -> xdg_surface#14.ack_configure(26)' \
  'Gtk: gdk_seat_get_keyboard: GDK_IS_SEAT assertion failed' \
  'Bearer secret-token private-account /home/private-runner https://private-server.invalid' \
  'xdg_toplevel#15.set_title("private-account /home/private-runner")' > "${fixture}"
wayland_protocol_ready "${fixture}"
summary="$(wayland_protocol_summary "${fixture}")"
[[ "${summary}" == *'wayland-surfaces=1'* ]]
[[ "${summary}" == *'wayland-xdg-surfaces=1'* ]]
[[ "${summary}" == *'wayland-get-toplevel=1'* ]]
[[ "${summary}" == *'wayland-size-requests=1'* ]]
[[ "${summary}" == *'wayland-configure-acks=1'* ]]
[[ "${summary}" == *'wayland-gtk-seat-assertions=1'* ]]
for sensitive in private-account secret-token /home/private-runner private-server.invalid Bearer set_title; do
  [[ "${summary}" != *"${sensitive}"* ]] || {
    echo 'FAIL: native Wayland diagnostic leaked private renderer text' >&2
    exit 1
  }
done
missing_summary="$(wayland_protocol_summary "${fixture}.missing")"
[[ "${missing_summary}" == 'wayland-log=unavailable' ]]
# Static guard on the real smoke error paths: no tailing raw client/Weston
# protocol, which can contain URLs, window titles and profile paths.
smoke_script="$(dirname "${BASH_SOURCE[0]}")/ci-linux-wayland-smoke.sh"
if grep -Eq '^[[:space:]]*(tail|cat)[[:space:]]+.*(app|weston)\.log' "${smoke_script}"; then
  echo 'FAIL: raw private native Wayland log dumped by smoke' >&2
  exit 1
fi
echo "PASS: native Wayland same-surface controls (${passed} valid / ${refused} invalid / 2 privacy / 0 skipped)"
