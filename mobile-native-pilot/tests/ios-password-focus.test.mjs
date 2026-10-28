import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterFocusedPassword, dismissUsernameKeyboard, NATIVE_TOOLBAR_DONE } from '../scripts/ios-password-focus.mjs';

function driver(states, type = 'XCUIElementTypeSecureTextField') {
  const writes = [], records = [], calls = []; let index = 0;
  return { writes, records, calls, ports: {
    targetId: 'secure-target', record: r => records.push(r),
    typePassword: async (id, value) => { calls.push({ method: 'POST', route: '/keyboard' }); writes.push({ route: `/element/${id}/value`, body: { text: value } }); },
    until: async (probe, label) => {
      for (let i = 0; i < states.length; i++) { if (await probe()) return; index++; }
      throw Error('MOBILE_AUTH_DEADLINE:' + label);
    },
    command: async (method, route, body) => {
      calls.push({ method, route });
      if (route === '/element/active') {
        if (states[index] instanceof Error) throw states[index];
        return states[index];
      }
      if (route.endsWith('/attribute/type')) return type;
      if (method === 'POST' && route.endsWith('/value')) writes.push({ route, body });
      else throw Error('UNEXPECTED_COMMAND');
    },
  } };
}
const active = id => ({ 'element-6066-11e4-a52e-4f735466cecf': id });
test('no password command is issued until the exact secure field owns keyboard focus', async () => {
  const d = driver([active('username'), active('secure-target')]);
  await enterFocusedPassword(d.ports, 'fixture-secret');
  assert.deepEqual(d.records, [
    { activeFound: true, targetMatches: false, secureType: false },
    { activeFound: true, targetMatches: true, secureType: true },
  ]);
  assert.deepEqual(d.writes, [{ route: '/element/secure-target/value', body: { text: 'fixture-secret' } }]);
  assert.equal(d.calls.at(-1).method, 'POST');
});
test('username focus, another secure field, absent and malformed active elements never receive the password', async () => {
  for (const state of [active('username'), active('other-secure'), {}, null,
    Error('WebDriver active failed (404; no such element)')]) {
    const d = driver([state]);
    await assert.rejects(enterFocusedPassword(d.ports, 'fixture-secret'), /^Error: MOBILE_AUTH_DEADLINE:password-keyboard-focus$/);
    assert.equal(d.writes.length, 0);
    assert.deepEqual(d.records[0].secureType, false);
  }
});
test('a matching id without a proven secure type fails closed', async () => {
  for (const type of ['XCUIElementTypeTextField', undefined, 'SecureTextField']) {
    const d = driver([active('secure-target')], type);
    // undefined would otherwise select the fixture default argument.
    if (type === undefined) d.ports.command = async (_method, route) => route === '/element/active' ? active('secure-target') : undefined;
    await assert.rejects(enterFocusedPassword(d.ports, 'fixture-secret'), /password-keyboard-focus/);
    assert.equal(d.writes.length, 0);
  }
});
test('driver transport/authentication failures are not swallowed as missing focus', async () => {
  const d = driver([Error('WebDriver active transport failed (ECONNRESET)')]);
  await assert.rejects(enterFocusedPassword(d.ports, 'fixture-secret'), /ECONNRESET/);
  assert.equal(d.writes.length, 0);
});
test('closed evidence never includes element ids, password, field values or driver payloads', async () => {
  const d = driver([active('secure-target')]); await enterFocusedPassword(d.ports, 'fixture-secret');
  assert.deepEqual(Object.keys(d.records[0]).sort(), ['activeFound', 'secureType', 'targetMatches']);
  assert.ok(Object.values(d.records[0]).every(x => typeof x === 'boolean'));
});

function keyboard(states, failure, toolbar = []) {
  let i = 0; const calls = [], proofs = [], controls = [];
  return { calls, proofs, controls, ports: {
    elements: async (using, type) => {
      if (using === 'xpath') { assert.equal(type, NATIVE_TOOLBAR_DONE); calls.push('observe-toolbar'); return toolbar; }
      assert.equal(using, 'class name'); assert.equal(type, 'XCUIElementTypeKeyboard');
      calls.push('observe-keyboard'); return Array(states[Math.min(i++, states.length - 1)]).fill({}); },
    native: async method => { calls.push(method); if (failure) throw failure; },
    command: async (method, route) => { assert.equal(method, 'POST'); assert.equal(route, '/element/toolbar-done/click'); calls.push('toolbar-done-click'); },
    record: p => proofs.push(p),
    recordControls: p => controls.push(p),
    until: async (probe, label) => { for (let n = 0; n < 4; n++) if (await probe()) return;
      throw Error('MOBILE_AUTH_DEADLINE:' + label); },
  } };
}
test('dismisses the actual username keyboard and observes its absence before returning', async () => {
  const k = keyboard([1, 1, 0, 0]); await dismissUsernameKeyboard(k.ports);
  assert.deepEqual(k.calls, ['observe-keyboard', 'observe-toolbar', 'hideKeyboard', 'observe-keyboard', 'observe-keyboard', 'observe-keyboard']);
  assert.equal(k.proofs.slice(0, -1).every(p => p.wasVisible && !p.dismissed), true);
  assert.deepEqual(k.proofs.at(-1), { wasVisible: true, dismissed: true });
});
test('an already absent keyboard needs no native dismissal command', async () => {
  const k = keyboard([0]); await dismissUsernameKeyboard(k.ports);
  assert.deepEqual(k.calls, ['observe-keyboard', 'observe-keyboard']); assert.equal(k.proofs.at(-1).dismissed, true);
});
test('a native dismissal call succeeding without hiding the keyboard remains a failure', async () => {
  const k = keyboard([1]); await assert.rejects(dismissUsernameKeyboard(k.ports), /MOBILE_AUTH_DEADLINE:username-keyboard-dismissed/);
  assert.equal(k.proofs.every(p => p.wasVisible && !p.dismissed), true);
  assert.equal(k.calls.filter(x => x === 'hideKeyboard').length, 1);
});
test('unsupported or failed native dismissal is propagated, never treated as success', async () => {
  const k = keyboard([1], Error('WebDriver sync failed (500; unsupported operation)'));
  await assert.rejects(dismissUsernameKeyboard(k.ports), /unsupported operation/);
  assert.equal(k.proofs.at(-1).dismissed, false);
});
test('a keyboard that appears after an initially absent frame must still be dismissed', async () => {
  const k = keyboard([0, 1, 0, 0]); await dismissUsernameKeyboard(k.ports);
  assert.equal(k.calls.filter(x => x === 'hideKeyboard').length, 1);
  assert.deepEqual(k.proofs.at(-1), { wasVisible: true, dismissed: true });
});

const done = { 'element-6066-11e4-a52e-4f735466cecf': 'toolbar-done' };
test('uses the uniquely observed native toolbar Done button and still requires keyboard absence', async () => {
  const k = keyboard([1, 0, 0], undefined, [done]); await dismissUsernameKeyboard(k.ports);
  assert.equal(k.calls.includes('hideKeyboard'), false);
  assert.equal(k.calls.filter(x => x === 'toolbar-done-click').length, 1);
  assert.deepEqual(k.controls, [{ toolbarDoneCount: 1, toolbarDoneSelected: true }]);
  assert.equal(k.proofs.at(-1).dismissed, true);
});
test('ambiguous or invalid toolbar controls never receive a click or bypass the focus gate', async () => {
  for (const [toolbar, error] of [[[done, done], 'LOGIN_KEYBOARD_DONE_NOT_UNIQUE'], [[{}], 'LOGIN_KEYBOARD_DONE_ID_REQUIRED']]) {
    const k = keyboard([1], undefined, toolbar); await assert.rejects(dismissUsernameKeyboard(k.ports), new RegExp(error));
    assert.equal(k.calls.some(x => x === 'toolbar-done-click' || x === 'hideKeyboard'), false);
    assert.equal(k.proofs.at(-1).dismissed, false);
  }
});
test('a toolbar click that does not hide the keyboard remains a deadline failure', async () => {
  const k = keyboard([1], undefined, [done]); await assert.rejects(dismissUsernameKeyboard(k.ports), /username-keyboard-dismissed/);
  assert.equal(k.calls.filter(x => x === 'toolbar-done-click').length, 1);
  assert.equal(k.proofs.every(p => !p.dismissed), true);
});
