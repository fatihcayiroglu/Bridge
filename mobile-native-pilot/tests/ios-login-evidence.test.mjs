import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loginEvidence } from '../scripts/ios-login-evidence.mjs';

const USER = 'and_A_388ccb9f', PASS = 'S3cret-PASSWORD-value';
const el = (type, attrs) => `<XCUIElementType${type} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`;
const page = (userValue, passValue, extra = '') => `<AppiumAUT>${[
  el('Button', { name: 'Sign In', label: 'Sign In', visible: 'true', y: '210', height: '40' }),
  el('Button', { name: 'Create Account', label: 'Create Account', visible: 'true', y: '210', height: '40' }),
  el('TextField', { name: 'USERNAME', value: userValue, visible: 'true', y: '300' }),
  el('SecureTextField', { name: 'PASSWORD', value: passValue, visible: 'true', y: '380' }),
  el('Button', { name: 'Sign In', label: 'Sign In', visible: 'true', y: '460', height: '48' }),
].join('')}${extra}</AppiumAUT>`;

test('reports both Sign In controls with their vertical position', () => {
  const e = loginEvidence(page(USER, '••••'), USER);
  assert.deepEqual(e.signInControls.map((c) => c.y), [210, 460]);
  assert.ok(e.labelsPresent.includes('Sign In') && e.labelsPresent.includes('Create Account'));
});

test('a username field holding exactly the username is told apart from one with the password appended', () => {
  const ok = loginEvidence(page(USER, '••••'), USER);
  assert.equal(ok.textFields[0].valueIsUsername, true);
  const bad = loginEvidence(page(USER + PASS, ''), USER);
  assert.equal(bad.textFields[0].valueIsUsername, false);
  assert.equal(bad.textFields[0].valueContainsUsername, true);
  assert.equal(bad.secureFields[0].valueLength, 0);
});

test('the required-fields message is detected from the allow-list only', () => {
  const e = loginEvidence(page(USER, '', el('StaticText', { name: 'All fields are required', label: 'All fields are required' }) + el('StaticText', { name: 'something else entirely' })), USER);
  assert.ok(e.labelsPresent.includes('All fields are required'));
  assert.ok(!JSON.stringify(e).includes('something else'));
});

test('no value, username or password text ever appears in the evidence', () => {
  const out = JSON.stringify(loginEvidence(page(USER + PASS, PASS), USER));
  for (const secret of [USER, PASS]) assert.ok(!out.includes(secret), secret);
  assert.deepEqual(loginEvidence('', USER).textFields, []);
  assert.equal(loginEvidence(page(USER, 'x'), undefined).textFields[0].valueIsUsername, false);
});

test('the iOS driver records the evidence on failure from the page source, not from argument values', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /import \{ loginEvidence, assertUsernameIntact, fieldGeometry, centerOf, tapActions \} from '\.\/ios-login-evidence\.mjs'/);
  assert.match(s, /facts\.failureUi\.login = loginEvidence\(s, activeUsername\)/);
});

test('the evidence is printed to the job log (artifacts are not downloadable) from the closed shape only', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /console\.log\(`IOS_LOGIN_EVIDENCE \$\{JSON\.stringify\(\{ stage: facts\.stage \?\? null, failure: facts\.failure, login: facts\.failureUi\.login, secretGeometry: facts\.secretGeometry \?\? null \}\)\}`\)/);
});

import { assertUsernameIntact } from '../scripts/ios-login-evidence.mjs';
test('the username field must hold exactly the username after typing; the failure is a closed code', () => {
  const ev = (userValue, extra = []) => loginEvidence(page(userValue, '••••', extra.join('')), USER);
  assert.equal(assertUsernameIntact(ev(USER)), true);
  assert.throws(() => assertUsernameIntact(ev(USER + PASS)), /^Error: LOGIN_PASSWORD_TYPED_INTO_USERNAME_FIELD$/);
  assert.throws(() => assertUsernameIntact(ev('')), /LOGIN_USERNAME_FIELD_NOT_SET/);
  assert.throws(() => assertUsernameIntact({ textFields: [] }), /LOGIN_USERNAME_FIELD_NOT_UNIQUE/);
  assert.throws(() => assertUsernameIntact({ textFields: [{ visible: true, valueIsUsername: true }, { visible: true, valueIsUsername: true }] }), /LOGIN_USERNAME_FIELD_NOT_UNIQUE/);
  assert.equal(assertUsernameIntact({ textFields: [{ visible: true, valueIsUsername: true }, { visible: false, valueIsUsername: false }] }), true, 'a hidden second field does not count');
  for (const code of ['LOGIN_PASSWORD_TYPED_INTO_USERNAME_FIELD', 'LOGIN_USERNAME_FIELD_NOT_SET', 'LOGIN_USERNAME_FIELD_NOT_UNIQUE']) assert.match(code, /^[A-Z_]+(?::[a-z-]+)?$/);
});

test('the iOS driver re-finds the password field after the username keyboard, taps it like a finger, then types and checks', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /import \{ loginEvidence, assertUsernameIntact, fieldGeometry, centerOf, tapActions \} from '\.\/ios-login-evidence\.mjs'/);
  assert.match(s, /\/element\/\$\{key\(fields\[0\]\)\}\/value`, \{ text: user\.username \}\);[\s\S]*?const freshSecrets = await elements\('class name', 'XCUIElementTypeSecureTextField'\);\s*assert\.ok\(freshSecrets\.length === 1, 'REAL_LOGIN_FIELDS_REQUIRED'\);/);
  assert.match(s, /await command\('POST', '\/actions', tapActions\(centerOf\(secretRect\)\)\);\s*await command\('POST', `\/element\/\$\{key\(freshSecrets\[0\]\)\}\/click`, \{\}\);\s*await command\('POST', `\/element\/\$\{key\(freshSecrets\[0\]\)\}\/value`, \{ text: password \}\);\s*assertUsernameIntact\(loginEvidence\(await command\('GET', '\/source'\), user\.username\)\);/);
  assert.ok(!/key\(secrets\[0\]\)\}\/value/.test(s), 'the stale element reference is never typed into');
});

import { fieldGeometry, centerOf, tapActions } from '../scripts/ios-login-evidence.mjs';
test('geometry helpers produce plain numbers, a centre, and a single touch tap', () => {
  assert.deepEqual(fieldGeometry({ x: 10.4, y: 20.6, width: 100, height: 40, label: 'secret' }), { x: 10, y: 21, width: 100, height: 40 });
  assert.deepEqual(fieldGeometry(undefined), { x: null, y: null, width: null, height: null });
  assert.deepEqual(centerOf({ x: 10, y: 20, width: 100, height: 40 }), { x: 60, y: 40 });
  for (const bad of [undefined, { x: 1, y: 1, width: 0, height: 5 }, { x: 'a', y: 1, width: 5, height: 5 }]) assert.throws(() => centerOf(bad), /LOGIN_FIELD_RECT_REQUIRED/);
  const t = tapActions({ x: 7, y: 9 });
  assert.equal(t.actions.length, 1);
  const kinds = t.actions[0].actions.map((a) => a.type);
  assert.deepEqual(kinds, ['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
  assert.equal(t.actions[0].parameters.pointerType, 'touch');
  assert.deepEqual([t.actions[0].actions[0].x, t.actions[0].actions[0].y], [7, 9]);
});

test('the printed login evidence carries the field geometry and nothing else free-form', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /login: facts\.failureUi\.login, secretGeometry: facts\.secretGeometry \?\? null/);
});
