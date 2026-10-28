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
  assert.match(s, /import \{ loginEvidence, uiSurvey, routeShape, keyActions, assertPasswordLanded, assertUsernameIntact, fieldGeometry, centerOf, tapActions, focusSnapshot \} from '\.\/ios-login-evidence\.mjs'/);
  assert.match(s, /facts\.failureUi\.login = loginEvidence\(s, activeUsername\)/);
});

test('the evidence is printed to the job log (artifacts are not downloadable) from the closed shape only', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /console\.log\(`IOS_LOGIN_EVIDENCE \$\{JSON\.stringify\(\{ stage: facts\.stage \?\? null, failure: facts\.failure, login: facts\.failureUi\.login, survey: facts\.failureUi\.survey, driverFailure: facts\.driverFailure \?\? null, failedAt: facts\.failedAt \?\? null, typing: \{ method: facts\.passwordTypingMethod \?\? null, keysRoute: facts\.keysRouteFailure \?\? null \}, secretGeometry: facts\.secretGeometry \?\? null, focusBeforePassword: facts\.focusBeforePassword \?\? null \}\)\}`\)/);
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
  assert.match(s, /import \{ loginEvidence, uiSurvey, routeShape, keyActions, assertPasswordLanded, assertUsernameIntact, fieldGeometry, centerOf, tapActions, focusSnapshot \} from '\.\/ios-login-evidence\.mjs'/);
  assert.match(s, /\/element\/\$\{key\(fields\[0\]\)\}\/value`, \{ text: user\.username \}\);[\s\S]*?const freshSecrets = await elements\('class name', 'XCUIElementTypeSecureTextField'\);\s*assert\.ok\(freshSecrets\.length === 1, 'REAL_LOGIN_FIELDS_REQUIRED'\);/);
  assert.match(s, /await command\('POST', '\/actions', tapActions\(centerOf\(secretRect\)\)\);\s*await command\('POST', `\/element\/\$\{key\(freshSecrets\[0\]\)\}\/click`, \{\}\);[\s\S]*?(?:\/\/[^\n]*\s*)*await typeIntoFocused\(password\);\s*const afterPassword = loginEvidence\(await command\('GET', '\/source'\), user\.username\);\s*assertUsernameIntact\(afterPassword\);/);
  assert.ok(!/key\(secrets\[0\]\)\}\/value/.test(s), 'the stale element reference is never typed into');
});

import { fieldGeometry, centerOf, tapActions, focusSnapshot } from '../scripts/ios-login-evidence.mjs';
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
  assert.match(s, /login: facts\.failureUi\.login, survey: facts\.failureUi\.survey, driverFailure: facts\.driverFailure \?\? null, failedAt: facts\.failedAt \?\? null, typing: \{ method: facts\.passwordTypingMethod \?\? null, keysRoute: facts\.keysRouteFailure \?\? null \}, secretGeometry: facts\.secretGeometry \?\? null/);
});

test('the page-source focus flag is read as true, false or unknown, never as free text', () => {
  const field = (type, attrs) => `<XCUIElementType${type} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`;
  const src = `<A>${field('TextField', { visible: 'true', y: '1', value: 'u', focused: 'false' })}${field('SecureTextField', { visible: 'true', y: '2', value: '', focused: 'true' })}</A>`;
  assert.deepEqual(focusSnapshot(loginEvidence(src, 'u')), { text: [false], secure: [true] });
  const none = `<A>${field('TextField', { visible: 'true', y: '1', value: 'u' })}${field('SecureTextField', { visible: 'true', y: '2', value: '' })}</A>`;
  assert.deepEqual(focusSnapshot(loginEvidence(none, 'u')), { text: [null], secure: [null] });
  assert.deepEqual(focusSnapshot(undefined), { text: [], secure: [] });
  assert.deepEqual(focusSnapshot({ textFields: [{ focused: 'yes' }] }), { text: [null], secure: [] });
});

test('the driver taps natively, then records the focus snapshot before typing the password', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /await native\('tap', centerOf\(secretRect\)\);\s*facts\.focusBeforePassword = focusSnapshot\(loginEvidence\(await command\('GET', '\/source'\), user\.username\)\);\s*(?:\/\/[^\n]*\s*)*await typeIntoFocused\(password\);/);
});

import { uiSurvey, routeShape, keyActions, assertPasswordLanded } from '../scripts/ios-login-evidence.mjs';
test('uiSurvey counts element types and reports only allow-listed names, never text or values', () => {
  const src = `<AppiumAUT>${[
    el('WebView', { visible: 'true' }), el('WebView', { visible: 'false' }),
    el('Button', { name: 'Continue', label: 'Continue' }), el('Button', { name: 'my_secret_name_42', label: 'tok_abc123' }),
    el('StaticText', { value: 'secret text value https://127.0.0.1:8443/x?code=abc' }),
  ].join('')}</AppiumAUT>`;
  const s = uiSurvey(src);
  assert.equal(s.byType.WebView, 2);
  assert.equal(s.visibleWebViews, 1);
  assert.deepEqual(s.namesPresent, ['Continue']);
  const out = JSON.stringify(s);
  assert.ok(!/secret|tok_abc|code=|127\.0\.0\.1/.test(out));
  assert.deepEqual(uiSurvey(undefined), { nodes: 0, byType: {}, namesPresent: [], visibleWebViews: 0, plainLabels: [] });
});
test('the failure handler prints the survey next to the login evidence', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /facts\.failureUi\.survey = uiSurvey\(s\);/);
  assert.match(s, /survey: facts\.failureUi\.survey, driverFailure/);
});

test('uiSurvey plainLabels keeps plain UI words and drops user names, URLs, tokens, long text and duplicates', () => {
  const src = `<AppiumAUT>${[
    el('Button', { name: 'Reload', label: 'Reload' }), el('Button', { name: 'Reload', label: 'Reload' }),
    el('StaticText', { name: 'Safari cannot open the page.', value: 'Safari cannot open the page.' }),
    el('StaticText', { name: 'and_A_388ccb9f' }), el('StaticText', { name: 'https://127.0.0.1:8443/x' }),
    el('Button', { name: 'tok_abc123' }), el('StaticText', { name: 'user@example.com' }),
    el('StaticText', { name: 'a'.repeat(41) }), el('Other', { name: 'Not A Control' }),
  ].join('')}</AppiumAUT>`;
  const labels = uiSurvey(src).plainLabels;
  assert.deepEqual(labels, ['Reload', 'Safari cannot open the page.']);
  assert.ok(uiSurvey(`<A>${Array.from({ length: 30 }, (_, i) => el('Button', { name: 'Word ' + 'abcdefghijklmnopqrstuvwxyz'[i % 26] + ' x' + 'q'.repeat(i) })).join('')}</A>`).plainLabels.length <= 12);
});

test('routeShape keeps the route shape and drops ids, queries and odd characters', () => {
  assert.equal(routeShape('POST', '/element/0F8B1C2D-1111-2222-3333-444455556666/value'), 'POST /element/:id/value');
  assert.equal(routeShape('GET', '/source?x=secret'), 'GET /source');
  assert.equal(routeShape('POST', '/execute/sync'), 'POST /execute/sync');
  assert.equal(routeShape('POST', '/a b<script>'), 'POST /?');
  assert.equal(routeShape('bad method', '/x'), '? /x');
});
test('the driver records the last route and the last mobile command, and prints them with the redacted driver failure', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /facts\.lastRoute = routeShape\(method, route\)/);
  assert.match(s, /facts\.lastNative = `mobile: \$\{name\}`/);
  assert.match(s, /driverFailure: facts\.driverFailure \?\? null, failedAt: facts\.failedAt \?\? null/);
});

test('the failing step is captured before the failure handler runs its own driver commands', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  const catchStart = s.indexOf('} catch (error) {');
  const capture = s.indexOf('facts.failedAt = { native: facts.lastNative ?? null, route: facts.lastRoute ?? null };', catchStart);
  const firstHandlerCommand = s.indexOf("await native('activeAppInfo')", catchStart);
  assert.ok(capture > catchStart && firstHandlerCommand > capture, 'failedAt is recorded before the first handler command');
});

test('keyActions types one keyDown/keyUp pair per character and refuses empty or oversized text', () => {
  const a = keyActions('a€').actions[0];
  assert.equal(a.type, 'key');
  assert.deepEqual(a.actions.map((x) => `${x.type}:${x.value}`), ['keyDown:a', 'keyUp:a', 'keyDown:€', 'keyUp:€']);
  assert.throws(() => keyActions(''), /KEY_TEXT_INVALID/);
  assert.throws(() => keyActions('x'.repeat(257)), /KEY_TEXT_INVALID/);
});
test('assertPasswordLanded needs exactly one visible secret field holding the typed length', () => {
  const ok = { secureFields: [{ visible: true, valueLength: 21 }] };
  assert.equal(assertPasswordLanded(ok, 21), true);
  assert.throws(() => assertPasswordLanded({ secureFields: [{ visible: true, valueLength: 0 }] }, 21), /LOGIN_PASSWORD_NOT_IN_SECRET_FIELD/);
  assert.throws(() => assertPasswordLanded({ secureFields: [{ visible: true, valueLength: 20 }] }, 21), /LOGIN_PASSWORD_NOT_IN_SECRET_FIELD/);
  assert.throws(() => assertPasswordLanded({ secureFields: [] }, 21), /LOGIN_SECRET_FIELD_NOT_UNIQUE/);
  assert.throws(() => assertPasswordLanded({ secureFields: [{ visible: true, valueLength: 21 }, { visible: true, valueLength: 21 }] }, 21), /LOGIN_SECRET_FIELD_NOT_UNIQUE/);
  assert.throws(() => assertPasswordLanded(undefined, 21), /LOGIN_SECRET_FIELD_NOT_UNIQUE/);
});
test('the driver types through the keys route or key actions, records the method, and checks the secret field', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.ok(!/native\('keys'/.test(s), 'mobile: keys returned 500 and is not used');
  assert.match(s, /await typeIntoFocused\(password\);\s*const afterPassword = loginEvidence\(await command\('GET', '\/source'\), user\.username\);\s*assertUsernameIntact\(afterPassword\);\s*assertPasswordLanded\(afterPassword, password\.length\);/);
  assert.match(s, /facts\.passwordTypingMethod = 'keys-route'/);
  assert.match(s, /await command\('POST', '\/actions', keyActions\(text\)\); facts\.passwordTypingMethod = 'key-actions'/);
});
