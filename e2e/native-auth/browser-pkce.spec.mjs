// Actual Chromium login/consent, actual HTTPS/PG16/Redis and pilot modules.
// The 303 is observed by the test driver, not page script. OS custom-scheme
// dispatch, Custom Tabs and ASWebAuthenticationSession are separate acceptance.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { createPkceAttempt } from '../../mobile-native-pilot/src/pkce.mjs';
import { createBrowserSignIn } from '../../mobile-native-pilot/src/browser-sign-in.mjs';
import { createBrowserSessionSignIn } from '../../mobile-native-pilot/src/browser-session.mjs';
import { createNativeAuthApi } from '../../mobile-native-pilot/src/native-auth-api.mjs';
import { createNativeCredentialPort } from '../../mobile-native-pilot/src/native-credential-port.mjs';
import { createSessionCoordinator } from '../../mobile-native-pilot/src/session-coordinator.mjs';
import { createBridgeReadApi } from '../../mobile-native-pilot/src/bridge-read-api.mjs';

const origin = process.env.BRIDGE_IT_ORIGIN;
const redirect = process.env.BRIDGE_IT_REDIRECT;
const password = process.env.BRIDGE_BROWSER_IT_PASSWORD;
assert.ok(origin?.startsWith('https://') && redirect && password?.length >= 32, 'ISOLATED_AUTH_CONFIG_REQUIRED');
const pkceCrypto = {
  randomBytes: n => new Uint8Array(crypto.randomBytes(n)),
  sha256: async value => new Uint8Array(crypto.createHash('sha256').update(value, 'ascii').digest()),
};

async function register(tag) {
  const username = `bui_${tag}_${crypto.randomBytes(5).toString('hex')}`;
  const response = await fetch(`${origin}/api/register`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.ok(response.status === 200, 'DISPOSABLE_USER_REGISTRATION_FAILED');
  const body = await response.json();
  return { username, userId: String(body.user._id ?? body.user.id) };
}

function app() {
  let stored = null;
  const credentials = createNativeCredentialPort({ secureStore: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, isAvailableAsync: async () => true,
    getItemAsync: async () => stored, setItemAsync: async (_key, value) => { stored = value; },
    deleteItemAsync: async () => { stored = null; },
  } });
  const authApi = createNativeAuthApi({ origin });
  const newCoordinator = () => createSessionCoordinator({ credentials, authApi,
    createReadApi: getSession => createBridgeReadApi({ origin, getSession }) });
  return { authApi, newCoordinator, stored: () => stored };
}

async function loginAndConsent(page, profile, url) {
  const response = await page.goto(url);
  assert.ok(response?.status() === 200, 'NATIVE_AUTH_DOCUMENT_FAILED');
  await page.locator('#l-username').fill(profile.username);
  // Do not attach a failed fill's plaintext argument to a CI error artifact.
  try { await page.locator('#l-password').fill(password); }
  catch { throw Error('LOGIN_PASSWORD_INPUT_FAILED'); }
  await page.locator('[data-auth-action="login"]').click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to the Bridge app?', exact: true });
  await expect(dialog).toBeVisible();
  // A browser fixture starts empty; no cookie or stored login is injected.
  const cookie = (await page.context().cookies()).find(item => item.name === 'bridge_refresh');
  await test.info().attach('cookie-boundary.json', { contentType: 'application/json',
    body: JSON.stringify({ found: !!cookie, httpOnly: cookie?.httpOnly === true, secure: cookie?.secure === true }) });
  assert.ok(cookie?.httpOnly === true && cookie.secure === true, 'REFRESH_COOKIE_BOUNDARY_FAILED');
  assert.ok(!(await page.evaluate(() => document.cookie)).includes('bridge_refresh'), 'REFRESH_COOKIE_SCRIPT_EXPOSURE');
  return dialog;
}

test('approved UI consent exchanges PKCE and restores with a rotated token', async ({ page }) => {
  const profile = await register('approve'), runtime = app(), coordinator = runtime.newCoordinator();
  const browser = createBrowserSignIn({ origin, redirectUri: redirect,
    createPkce: () => createPkceAttempt(pkceCrypto),
    openAuthSession: async url => {
      const dialog = await loginAndConsent(page, profile, url);
      const authorized = page.waitForResponse(response => new URL(response.url()).pathname === '/api/refresh/native-authorize');
      await dialog.locator('[data-product-dialog-action="confirm"]').click();
      const response = await authorized;
      const headers = await response.request().allHeaders();
      await test.info().attach('authorize-boundary.json', { contentType: 'application/json', body: JSON.stringify({
        status: response.status(), origin: headers.origin === origin ? 'expected' : headers.origin === 'null' ? 'null' : headers.origin ? 'other' : 'absent',
        sameOriginFetch: headers['sec-fetch-site'] === 'same-origin',
      }) });
      assert.ok(response.status() === 303, 'CONSENT_DID_NOT_ISSUE_REDIRECT');
      assert.ok(response.request().method() === 'POST', 'CONSENT_WAS_NOT_A_FORM_POST');
      assert.ok(headers.origin === origin && headers['sec-fetch-site'] === 'same-origin', 'BROWSER_ORIGIN_BOUNDARY_FAILED');
      return { type: 'success', url: response.headers().location };
    },
  });
  await createBrowserSessionSignIn({ browser, authApi: runtime.authApi, coordinator })();
  assert.ok(coordinator.getState().userId === profile.userId, 'NATIVE_ACCOUNT_MISMATCH');
  const first = runtime.stored();
  assert.ok(typeof first === 'string' && first.length > 0, 'REFRESH_CREDENTIAL_NOT_STORED');
  const restored = runtime.newCoordinator();
  await restored.restore();
  assert.ok(restored.getState().userId === profile.userId, 'RESTORED_ACCOUNT_MISMATCH');
  assert.ok(runtime.stored() !== first, 'RESTORE_DID_NOT_ROTATE');
  const me = await createBridgeReadApi({ origin, getSession: () => restored.getSession() }).getMe();
  assert.ok(me.id === profile.userId, 'RESTORED_READ_ACCOUNT_MISMATCH');
  await restored.signOut();
  assert.ok(runtime.stored() === null && restored.getState().serverSignOut === 'confirmed', 'REVOCATION_NOT_CONFIRMED');
});

test('cancelled UI consent issues no native session, including after web reload', async ({ page }) => {
  const profile = await register('cancel'), runtime = app(), coordinator = runtime.newCoordinator();
  let authorizations = 0, exchanges = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/refresh/native-authorize') authorizations++;
  });
  const browser = createBrowserSignIn({ origin, redirectUri: redirect,
    createPkce: () => createPkceAttempt(pkceCrypto),
    openAuthSession: async url => {
      const dialog = await loginAndConsent(page, profile, url);
      await dialog.locator('[data-product-dialog-action="cancel"]').click();
      await expect(dialog).toHaveCount(0);
      return { type: 'cancel' };
    },
  });
  const signIn = createBrowserSessionSignIn({ browser, coordinator,
    authApi: { ...runtime.authApi, exchangeCode: async callback => { exchanges++; return runtime.authApi.exchangeCode(callback); } } });
  await assert.rejects(signIn(), error => error.code === 'CANCELLED');
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('[data-bridge-product-dialog]')).toHaveCount(0);
  assert.ok(authorizations === 0 && exchanges === 0, 'CANCELLED_CONSENT_ISSUED_NATIVE_AUTH');
  assert.ok(coordinator.getSession() === null && runtime.stored() === null, 'CANCELLED_CONSENT_ADOPTED');
});

test('the same Chromium configuration rejects a genuinely untrusted TLS certificate', async ({ page }) => {
  let requests = 0;
  const server = https.createServer({ key: readFileSync(process.env.IT_UNTRUSTED_KEY),
    cert: readFileSync(process.env.IT_UNTRUSTED_CERT) }, (_req, res) => {
    requests++; res.end('must not be accepted');
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8444, '127.0.0.1', resolve); });
  try {
    await assert.rejects(page.goto('https://127.0.0.1:8444/'), error => String(error).includes('ERR_CERT_AUTHORITY_INVALID'));
    assert.ok(requests === 0, 'UNTRUSTED_TLS_REACHED_HTTP');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
