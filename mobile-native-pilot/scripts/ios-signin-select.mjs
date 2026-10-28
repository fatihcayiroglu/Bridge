// The Bridge login page has TWO controls named "Sign In": the active tab (client/index.html:140, first in the
// page) and the submit button below the password field (:150). Selecting "the first Sign In" clicks the tab, a
// no-op, so the login is never submitted and the consent page never appears (iOS journeys: case 2,
// MOBILE_AUTH_DEADLINE:explicit-consent, 3 of 3 runs that reached it). Choose the control below the password field.
export function chooseSubmitIndex(rects, passwordRect) {
  const ok = (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  if (!ok(passwordRect)) throw new Error('PASSWORD_FIELD_RECT_REQUIRED');
  const below = [];
  rects.forEach((r, i) => { if (ok(r) && r.y >= passwordRect.y + passwordRect.height) below.push(i); });
  if (below.length > 1) throw new Error('AMBIGUOUS_SIGN_IN_SUBMIT');
  return below.length === 1 ? below[0] : -1; // -1: not rendered yet, the caller keeps waiting
}
