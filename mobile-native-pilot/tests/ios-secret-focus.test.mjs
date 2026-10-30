import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSecretKeyboardFocus } from '../scripts/ios-secret-focus.mjs';
const TEXT = 'XCUIElementTypeTextField', SECRET = 'XCUIElementTypeSecureTextField';
const form = () => ({ textFields: [{ visible: true, valueIsUsername: true }], secureFields: [{ visible: true }] });
function setup(types, snapshot = form()) {
  const events = [], recorded = [];
  return { events, recorded, options: {
    activeType: async () => { events.push('active'); return types.shift(); },
    pressTab: async () => { events.push('tab'); },
    evidence: async () => { events.push('evidence'); return snapshot; },
    record: type => recorded.push(type),
  } };
}
test('a verified secure active field needs no extra keyboard navigation', async () => {
  const f = setup([SECRET]);
  assert.equal(await requireSecretKeyboardFocus(f.options), 'already-secure');
  assert.deepEqual(f.events, ['active', 'evidence']);
});
test('username keyboard focus advances once and requires secure focus before accepting the form', async () => {
  const f = setup([TEXT, SECRET]);
  assert.equal(await requireSecretKeyboardFocus(f.options), 'keyboard-tab');
  assert.deepEqual(f.events, ['active', 'tab', 'active', 'evidence']);
  assert.deepEqual(f.recorded, [TEXT, SECRET]);
});
test('a tab that leaves username focus fails closed without repeated attempts', async () => {
  const f = setup([TEXT, TEXT]);
  await assert.rejects(requireSecretKeyboardFocus(f.options), /LOGIN_SECRET_KEYBOARD_FOCUS_REQUIRED/);
  assert.deepEqual(f.events, ['active', 'tab', 'active']);
});
test('unknown active controls do not receive navigation or leak their raw type', async () => {
  const f = setup(['Private Account SecretPassword']);
  await assert.rejects(requireSecretKeyboardFocus(f.options), /LOGIN_SECRET_KEYBOARD_FOCUS_REQUIRED/);
  assert.deepEqual(f.events, ['active']); assert.deepEqual(f.recorded, ['other']);
});
test('an active-element transport error propagates without a focus fallback', async () => {
  const f = setup([TEXT]); const original = new Error('CONTROLLED_TRANSPORT_ERROR');
  f.options.activeType = async () => { throw original; };
  await assert.rejects(requireSecretKeyboardFocus(f.options), error => error === original);
  assert.deepEqual(f.events, []);
});
test('secure focus does not accept a changed username or multiple visible secret fields', async () => {
  const changed = form(); changed.textFields[0].valueIsUsername = false;
  await assert.rejects(requireSecretKeyboardFocus(setup([SECRET], changed).options), /LOGIN_USERNAME_FIELD_NOT_SET/);
  const duplicate = form(); duplicate.secureFields.push({ visible: true });
  await assert.rejects(requireSecretKeyboardFocus(setup([SECRET], duplicate).options), /LOGIN_SECRET_FIELD_NOT_UNIQUE/);
});
