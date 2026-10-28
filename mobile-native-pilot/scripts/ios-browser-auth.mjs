// Drives the REAL RN screen and system authentication UI via native XCUITest.
// No WebView JavaScript, injected cookies/tokens/callbacks, openurl or fake browser.
import { chooseSubmitIndex } from './ios-signin-select.mjs';
import { enterFocusedPassword, dismissUsernameKeyboard } from './ios-password-focus.mjs';
import { loginEvidence, assertUsernameIntact, fieldGeometry, centerOf, tapActions, focusSnapshot } from './ios-login-evidence.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { webdriverRequest } from '../../e2e/ios/webdriver-http.mjs';

const require = createRequire(import.meta.url);
const { Client } = require('../../server/node_modules/pg');
const origin = process.env.BRIDGE_IT_ORIGIN;
const password = process.env.BRIDGE_MOBILE_PASSWORD;
const bundle = 'com.bridge.nativepilot';
const out = path.resolve(process.env.MOBILE_AUTH_EVIDENCE || 'mobile-auth-evidence');
assert.ok(origin === 'https://127.0.0.1:8443' && password?.length >= 32, 'ISOLATED_HTTPS_CONFIG_REQUIRED');
fs.mkdirSync(out, { recursive: true });
const facts = { category: 'AUTOMATED / IOS SIMULATOR / DEBUG', status: 'FAIL', stage: 'prerequisites',
  cases: [], browserApi: 'ASWebAuthenticationSession via expo-web-browser', physicalDevice: false };
let session, database, activeCase;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wd = (method, route, body, timeout) => webdriverRequest('http://127.0.0.1:4723', method, route, body, timeout);
const command = (method, route, body) => wd(method, `/session/${session}${route}`, body);
const native = (name, args = {}) => command('POST', '/execute/sync', { script: `mobile: ${name}`, args: [args] });
const key = value => value?.['element-6066-11e4-a52e-4f735466cecf'] ?? value?.ELEMENT;
async function until(action, label, timeout = 60000) {
  facts.lastWait = label;
  const end = performance.now() + timeout;
  while (performance.now() < end) { const result = await action(); if (result) return result; await pause(500); }
  throw Error(`MOBILE_AUTH_DEADLINE:${label}`);
}
async function elements(using, value) {
  return command('POST', '/elements', { using, value });
}
const byName = name => elements('accessibility id', name);
async function nativeScreen(name) {
  const active = await native('activeAppInfo');
  if (active.bundleId !== bundle || !(await byName(name)).length) return false;
  const source = await command('GET', '/source');
  return !source.includes('XCUIElementTypeWebView');
}
async function clickName(name) {
  const found = await until(async () => (await byName(name))[0], 'native-control');
  await command('POST', `/element/${key(found)}/click`, {});
}
// Two controls are named "Sign In" (the tab and the submit button); click the one below the password field.
async function clickSignInSubmit(passwordElement) {
  const passwordRect = await command('GET', `/element/${key(passwordElement)}/rect`);
  const chosen = await until(async () => {
    const all = await byName('Sign In');
    facts.signInMatches = all.length;
    const rects = [];
    for (const element of all) rects.push(await command('GET', `/element/${key(element)}/rect`));
    const index = chooseSubmitIndex(rects, passwordRect);
    return index < 0 ? null : all[index];
  }, 'sign-in-submit');
  await command('POST', `/element/${key(chosen)}/click`, {});
}
async function screenshot(label) {
  const bytes = await command('GET', '/screenshot');
  fs.writeFileSync(path.join(out, `${label}.png`), Buffer.from(bytes, 'base64'));
}
function wire(kind) {
  const prefix = 'NATIVE_AUTH_HTTP ';
  return fs.readFileSync(process.env.BRIDGE_IT_PROXY_EVIDENCE, 'utf8').split('\n')
    .filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)))
    .filter(row => row.kind === kind);
}
async function api(method, route, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (token && method !== 'GET') {
    const csrf = await api('GET', '/api/csrf-token', token);
    headers['X-CSRF-Token'] = csrf.token;
  }
  const response = await fetch(origin + route, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, 'DISPOSABLE_FIXTURE_API_FAILED');
  return response.json();
}
async function fixture(tag) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const username = `mob_${tag}_${suffix}`;
  const registration = await api('POST', '/api/register', null, { username, password });
  const userId = String(registration.user._id ?? registration.user.id);
  const serverName = `Mobile ${tag} ${suffix}`;
  await api('POST', '/api/servers', registration.token, { name: serverName });
  return { username, userId, serverName };
}
async function families(user) {
  const { rows } = await database.query('SELECT DISTINCT family FROM refresh_tokens WHERE "userId"=$1 AND family IS NOT NULL', [user.userId]);
  return new Set(rows.map(row => row.family));
}
async function tokens(user, family) {
  const { rows } = await database.query('SELECT token, used FROM refresh_tokens WHERE "userId"=$1 AND family=$2', [user.userId, family]);
  return rows;
}
async function browserReady() {
  let promptHandled = false;
  await until(async () => {
    const fields = await elements('class name', 'XCUIElementTypeTextField');
    if (fields.length) return true;
    const buttons = await byName('Continue');
    if (buttons.length && !promptHandled) { await command('POST', `/element/${key(buttons[0])}/click`, {}); promptHandled = true; }
    return false;
  }, 'system-authentication-browser');
  const source = await command('GET', '/source');
  assert.ok(source.includes('XCUIElementTypeWebView'), 'SYSTEM_BROWSER_WEBVIEW_REQUIRED');
  const active = await native('activeAppInfo');
  facts.browserBundle = active.bundleId;
  assert.ok([bundle, 'com.apple.SafariViewService', 'com.apple.AuthenticationServicesUI'].includes(active.bundleId), 'UNEXPECTED_AUTHENTICATION_APPLICATION');
  facts.systemBrowserObserved = true;
}
let activeUsername;
async function signIn(user, expectedPid) {
  activeUsername = user.username;
  await browserReady();
  const fields = await elements('class name', 'XCUIElementTypeTextField');
  const secrets = await elements('class name', 'XCUIElementTypeSecureTextField');
  assert.ok(fields.length === 1 && secrets.length === 1, 'REAL_LOGIN_FIELDS_REQUIRED');
  const secretBefore = fieldGeometry(await command('GET', `/element/${key(secrets[0])}/rect`));
  await command('POST', `/element/${key(fields[0])}/value`, { text: user.username });
  // Run40730915313 proved the active element remained different from the secure
  // field after the coordinate/click sequence. Remove the username keyboard and
  // prove that transition before obtaining a new password-element reference.
  await dismissUsernameKeyboard({ elements, native, until,
    record: proof => { facts.usernameKeyboard = proof; } });
  // The page moves once the username keyboard is up, so the first element reference can point at a stale position
  // (runs 40700229648 and 40706730676: the password still landed in the username field). Look the field up again,
  // record where it is now, touch that spot like a finger, and only then type.
  const freshSecrets = await elements('class name', 'XCUIElementTypeSecureTextField');
  assert.ok(freshSecrets.length === 1, 'REAL_LOGIN_FIELDS_REQUIRED');
  const secretRect = await command('GET', `/element/${key(freshSecrets[0])}/rect`);
  facts.secretGeometry = { beforeUsername: secretBefore, afterUsername: fieldGeometry(secretRect) };
  await command('POST', '/actions', tapActions(centerOf(secretRect)));
  await command('POST', `/element/${key(freshSecrets[0])}/click`, {});
  // A native coordinate tap as well, then record which field the page source says holds focus before typing
  // (run 40717519808: the password still landed in the username field after the touch action above).
  await native('tap', centerOf(secretRect));
  facts.focusBeforePassword = focusSnapshot(loginEvidence(await command('GET', '/source'), user.username));
  // Element-addressed typing previously ran without a positive keyboard-focus
  // proof. Keep that proof mandatory; type only through its verified element,
  // using the native value API rather than unqualified hardware-key simulation.
  await enterFocusedPassword({ targetId: key(freshSecrets[0]), command, until,
    typePassword: (id, value) => command('POST', `/element/${id}/value`, { text: value }),
    record: proof => { facts.passwordKeyboardFocus = proof; } }, password);
  assertUsernameIntact(loginEvidence(await command('GET', '/source'), user.username));
  await clickSignInSubmit(secrets[0]);
  await until(async () => (await byName('Continue in the app')).length > 0, 'explicit-consent');
  await screenshot(`consent-${activeCase}`);
  const before = await families(user);
  const codes = wire('native-code').length;
  await clickName('Continue in the app');
  await until(() => nativeScreen(user.serverName), 'native-account-community');
  assert.ok((await byName('Sign out')).length > 0 && (await byName('Switch account')).length > 0, 'REAL_NATIVE_AUTHENTICATED_SCREEN_REQUIRED');
  const returned = await native('activeAppInfo');
  assert.ok(returned.bundleId === bundle && Number(returned.pid) > 0, 'OS_CALLBACK_MUST_RETURN_TO_NATIVE_APP');
  assert.ok(returned.pid === expectedPid, 'CALLBACK_MUST_RESUME_THE_ORIGINAL_NATIVE_PROCESS');
  const exchanges = wire('native-code').slice(codes);
  assert.ok(exchanges.length === 1 && exchanges[0].status === 200 && exchanges[0].cookiePresent === false, 'SINGLE_NATIVE_PKCE_EXCHANGE_REQUIRED');
  const after = [...await families(user)].filter(value => !before.has(value));
  assert.ok(after.length === 1, 'ONE_NEW_NATIVE_REFRESH_FAMILY_REQUIRED');
  const live = (await tokens(user, after[0])).filter(row => !row.used);
  assert.ok(live.length === 1, 'ONE_NATIVE_REFRESH_CREDENTIAL_REQUIRED');
  await screenshot(`native-${activeCase}`);
  return { family: after[0], token: live[0].token, pid: returned.pid };
}
async function restart(user, issued) {
  const count = wire('native-refresh').length;
  await native('terminateApp', { bundleId: bundle });
  assert.ok(await native('queryAppState', { bundleId: bundle }) === 1, 'NATIVE_PROCESS_MUST_TERMINATE');
  await native('activateApp', { bundleId: bundle });
  await until(() => nativeScreen(user.serverName), 'protected-storage-restoration');
  const current = await native('activeAppInfo');
  assert.ok(current.bundleId === bundle && current.pid !== issued.pid, 'RESTORE_REQUIRES_NEW_PROCESS');
  const requests = wire('native-refresh').slice(count);
  assert.ok(requests.length === 1 && requests[0].status === 200 && requests[0].cookiePresent === false, 'SINGLE_NATIVE_ROTATION_REQUIRED');
  const rows = await tokens(user, issued.family);
  const predecessor = rows.find(row => row.token === issued.token), successor = rows.filter(row => !row.used);
  assert.ok(predecessor?.used === true && successor.length === 1 && successor[0].token !== issued.token, 'ATOMIC_POSTGRES_ROTATION_REQUIRED');
  return { family: issued.family, token: successor[0].token, pid: current.pid };
}
async function runCase(id, action) {
  activeCase = id; facts.stage = id;
  const item = { id, status: 'FAIL' }; facts.cases.push(item);
  await action(); item.status = 'PASS';
}
try {
  database = new Client({ connectionString: process.env.DATABASE_URL }); await database.connect();
  assert.ok(String((await database.query('SHOW server_version_num')).rows[0].server_version_num).startsWith('16'), 'REAL_POSTGRES16_REQUIRED');
  const a = await fixture('A'), b = await fixture('B');
  facts.stage = 'native-xcuitest-session';
  facts.driverDeadlineMs = 240000;
  const created = await wd('POST', '/session', { capabilities: { alwaysMatch: {
    platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': process.env.IOS_SIMULATOR_UDID,
    'appium:app': path.resolve(process.env.IOS_APP_PATH), 'appium:bundleId': bundle,
    'appium:isHeadless': true, 'appium:noReset': true, 'appium:autoAcceptAlerts': false,
    'appium:showXcodeLog': true,
    // Use the WebDriverAgent compiled in the previous step; never rebuild it inside the journey's deadline.
    ...(process.env.WDA_DERIVED_DATA ? { 'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': process.env.WDA_DERIVED_DATA } : {}),
    'appium:printPageSourceOnFindFailure': false, 'appium:newCommandTimeout': 180,
  } } }, 240000);
  session = created.sessionId; assert.ok(session, 'NATIVE_XCTEST_SESSION_REQUIRED');
  const runtime = created.capabilities?.platformVersion;
  if (typeof runtime === 'string' && /^\d+(\.\d+){0,2}$/.test(runtime)) facts.runtimeVersion = runtime;
  await until(async () => (await byName('Sign in with your browser')).length > 0, 'native-sign-in-screen');
  const initial = await native('activeAppInfo');
  assert.ok(initial.bundleId === bundle && Number(initial.pid) > 0, 'NATIVE_APPLICATION_REQUIRED');
  await runCase('IOS_SYSTEM_BROWSER_CANCEL', async () => {
    const count = wire('native-code').length;
    await clickName('Sign in with your browser'); await browserReady();
    await clickName('Cancel');
    await until(() => nativeScreen('Sign in with your browser'), 'cancelled-native-return');
    assert.ok((await native('activeAppInfo')).pid === initial.pid, 'CANCEL_MUST_RESUME_ORIGINAL_PROCESS');
    assert.ok(wire('native-code').length === count, 'CANCEL_MUST_NOT_EXCHANGE_A_CODE');
  });
  let first;
  await runCase('IOS_AUTHENTICATE_RESTART_ROTATE', async () => {
    await clickName('Sign in with your browser'); first = await signIn(a, initial.pid);
    assert.ok((await byName(b.serverName)).length === 0, 'OTHER_ACCOUNT_COMMUNITY_LEAK');
    first = await restart(a, first);
  });
  await runCase('IOS_SWITCH_ISOLATE_REVOKE_RESTART', async () => {
    await clickName('Switch account'); const second = await signIn(b, first.pid);
    assert.ok((await byName(a.serverName)).length === 0, 'PREVIOUS_ACCOUNT_COMMUNITY_LEAK');
    assert.ok((await tokens(a, first.family)).filter(row => !row.used).length === 0, 'PREVIOUS_ACCOUNT_NOT_REVOKED');
    const restored = await restart(b, second);
    await clickName('Sign out');
    await until(() => nativeScreen('Sign in with your browser'), 'signed-out-native-screen');
    assert.ok((await tokens(b, restored.family)).filter(row => !row.used).length === 0, 'SIGN_OUT_MUST_REVOKE');
    const rejected = await fetch(origin + '/api/native-auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: restored.token }) });
    assert.ok(rejected.status === 401, 'SIGNED_OUT_CREDENTIAL_MUST_BE_REJECTED');
    const count = wire('native-refresh').length;
    await native('terminateApp', { bundleId: bundle }); await native('activateApp', { bundleId: bundle });
    await until(() => nativeScreen('Sign in with your browser'), 'signed-out-restart');
    assert.ok((await byName(b.serverName)).length === 0 && wire('native-refresh').length === count, 'SIGNED_OUT_CREDENTIAL_RESTORED');
  });
  facts.status = 'PASS'; facts.stage = 'complete';
} catch (error) {
  facts.failure = /^[A-Z_]+(?::[a-z-]+)?$/.test(error?.message ?? '') ? error.message : 'DRIVER_OR_SERVICE_FAILED';
  console.log(`IOS_PASSWORD_FOCUS ${JSON.stringify(facts.passwordKeyboardFocus ?? null)}`);
  console.log(`IOS_USERNAME_KEYBOARD ${JSON.stringify(facts.usernameKeyboard ?? null)}`);
  if (error?.message?.startsWith('WebDriver ')) facts.driverFailure = error.message;
  // Driver/server messages can contain credentials or callback URLs. Preserve
  // the closed stage, AX counts and screenshots, never raw source/arguments.
  if (session) {
    try { const active = await native('activeAppInfo'); facts.failureApplication = { bundleId: active.bundleId, pid: active.pid }; } catch {}
    try { const s = await command('GET', '/source'); facts.failureUi = { webViews: (s.match(/XCUIElementTypeWebView\b/g) || []).length,
      textFields: (s.match(/XCUIElementTypeTextField\b/g) || []).length, secureFields: (s.match(/XCUIElementTypeSecureTextField\b/g) || []).length,
      alerts: (s.match(/XCUIElementTypeAlert\b/g) || []).length };
      // Closed shape only: counts, lengths, allow-listed labels - never a field value or credential.
      facts.failureUi.login = loginEvidence(s, activeUsername);
      console.log(`IOS_LOGIN_EVIDENCE ${JSON.stringify({ stage: facts.stage ?? null, failure: facts.failure, login: facts.failureUi.login, secretGeometry: facts.secretGeometry ?? null, focusBeforePassword: facts.focusBeforePassword ?? null })}`);
      await screenshot('first-failure'); } catch {}
  }
  process.exitCode = 1;
} finally {
  facts.notExecuted = ['IOS_SYSTEM_BROWSER_CANCEL', 'IOS_AUTHENTICATE_RESTART_ROTATE', 'IOS_SWITCH_ISOLATE_REVOKE_RESTART']
    .filter(id => !facts.cases.some(item => item.id === id));
  fs.writeFileSync(path.join(out, 'ios-browser-auth.json'), JSON.stringify(facts, null, 2));
  if (session) { try { await wd('DELETE', `/session/${session}`, undefined, 30000); } catch {} }
  if (database) await database.end();
  console.log(JSON.stringify({ status: facts.status, stage: facts.stage, passed: facts.cases.filter(item => item.status === 'PASS').length,
    failed: facts.cases.filter(item => item.status === 'FAIL').length, notExecuted: facts.notExecuted.length, skipped: 0 }));
}
