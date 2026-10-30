import { assertUsernameIntact } from './ios-login-evidence.mjs';

// Native WDA /element/active uses hasKeyboardFocus. AX XML's `focused` is
// absent on this iOS WebKit view; a coordinate tap alone proves no focus.
export async function requireSecretKeyboardFocus({ activeType, pressTab, evidence, record }) {
  const read = async () => {
    const type = await activeType();
    const closed = ['XCUIElementTypeTextField', 'XCUIElementTypeSecureTextField'].includes(type) ? type : 'other';
    record(closed);
    return closed;
  };
  let current = await read();
  let method = 'already-secure';
  if (current === 'XCUIElementTypeTextField') {
    // One ordinary keyboard navigation action, never a text/JS focus injection.
    await pressTab(); method = 'keyboard-tab'; current = await read();
  }
  if (current !== 'XCUIElementTypeSecureTextField') throw new Error('LOGIN_SECRET_KEYBOARD_FOCUS_REQUIRED');
  const form = await evidence();
  assertUsernameIntact(form);
  if (form.secureFields.filter(field => field.visible).length !== 1) throw new Error('LOGIN_SECRET_FIELD_NOT_UNIQUE');
  return method;
}
