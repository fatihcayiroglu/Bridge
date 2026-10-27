// REAL-BACKEND integration of the pilot's native sign-in and session modules.
//
// Runs the pilot's own browser-sign-in, native-auth-api, session-coordinator,
// native-credential-port and bridge-read-api against a running Bridge server with
// native auth enabled (server PR #518) on real PostgreSQL and Redis. Only two
// things are simulated: the system browser (an HTTP client that does what the
// Bridge web page's consent form does) and SecureStore (in-memory).
//
// Evidence category: BACKEND INTEGRATION. Not Custom Tabs, ASWebAuthenticationSession,
// Keychain/Keystore, emulator or device evidence.
//
//   BRIDGE_IT_ORIGIN=https://localhost:8443 BRIDGE_IT_REDIRECT=com.bridge.nativepilot:/oauth \
//   NODE_EXTRA_CA_CERTS=ca.crt node --test integration/native-auth-backend.it.mjs
//
// Missing configuration FAILS the run; nothing here is ever skipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { createPkceAttempt } from '../src/pkce.mjs';
import { createBrowserSignIn } from '../src/browser-sign-in.mjs';
import { createNativeAuthApi } from '../src/native-auth-api.mjs';
import { createSessionCoordinator } from '../src/session-coordinator.mjs';
import { createNativeCredentialPort } from '../src/native-credential-port.mjs';
import { createBridgeReadApi } from '../src/bridge-read-api.mjs';

const ORIGIN = process.env.BRIDGE_IT_ORIGIN;
const REDIRECT = process.env.BRIDGE_IT_REDIRECT;
assert.ok(ORIGIN && ORIGIN.startsWith('https://'), 'BRIDGE_IT_ORIGIN (https) is required');
assert.ok(REDIRECT, 'BRIDGE_IT_REDIRECT is required');

const PASSWORD = 'native-it-' + crypto.randomBytes(6).toString('hex');
const nodeCrypto = {
  randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  sha256: async (s) => new Uint8Array(crypto.createHash('sha256').update(s, 'ascii').digest()),
};

/** Counts native token requests so single-flight can be checked on the wire. */
const wire = { refresh: 0 };
const countingFetch = (url, init) => {
  if (String(url).endsWith('/api/native-auth/refresh')) wire.refresh += 1;
  return fetch(url, init);
};

function refreshCookie(res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const m = /^bridge_refresh=([^;]+)/.exec(line);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** A browser profile: the httpOnly refresh cookie the web app would hold. */
async function browserRegister(tag) {
  const username = `nit_${tag}_${crypto.randomBytes(3).toString('hex')}`;
  const res = await fetch(`${ORIGIN}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `register ${tag}: ${res.status}`);
  return { username, cookie: refreshCookie(res), access: body.token, stepUp: body.stepUp, userId: String(body.user._id ?? body.user.id) };
}

/** What the web page's consent form does: a same-origin form POST with the cookie. */
async function consent(profile, url) {
  const q = new URL(url).searchParams;
  const form = new URLSearchParams({
    redirect_uri: q.get('redirect_uri'), code_challenge: q.get('code_challenge'),
    code_challenge_method: q.get('code_challenge_method'), state: q.get('state'),
  });
  const res = await fetch(`${ORIGIN}/api/refresh/native-authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin',
      ...(profile.cookie ? { Cookie: `bridge_refresh=${profile.cookie}` } : {}) },
    body: form,
  });
  const rotated = refreshCookie(res);
  if (rotated) profile.cookie = rotated;
  return res;
}

function browserFor(profile, seen = {}) {
  return createBrowserSignIn({
    origin: ORIGIN, redirectUri: REDIRECT,
    createPkce: () => createPkceAttempt(nodeCrypto),
    openAuthSession: async (url) => {
      const res = await consent(profile, url);
      seen.status = res.status;
      if (res.status !== 303) return { type: 'dismiss' };
      return { type: 'success', url: res.headers.get('location') };
    },
  });
}

function memoryStore() {
  let secret = null;
  return {
    native: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
      async isAvailableAsync() { return true; },
      async getItemAsync() { return secret; },
      async setItemAsync(_k, v) { secret = v; },
      async deleteItemAsync() { secret = null; },
    },
    stored: () => secret,
  };
}

function app(store = memoryStore()) {
  const authApi = createNativeAuthApi({ origin: ORIGIN, fetchImpl: countingFetch });
  const coordinator = createSessionCoordinator({
    credentials: createNativeCredentialPort({ secureStore: store.native }),
    authApi,
    createReadApi: (getSession) => createBridgeReadApi({ origin: ORIGIN, getSession }),
  });
  const read = createBridgeReadApi({ origin: ORIGIN, getSession: () => coordinator.getSession() });
  return { authApi, coordinator, read, store };
}

async function signIn(profile, a = app()) {
  const callback = await browserFor(profile).start();
  const issued = await a.authApi.exchangeCode(callback);
  await a.coordinator.signIn(issued);
  return { ...a, issued, callback };
}

function totp(base32, step = Math.floor(Date.now() / 30_000)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

test('sign-in: consent → exchange → session; the server names the same account; only the refresh token is stored', async () => {
  const a = await browserRegister('a');
  const s = await signIn(a);
  const me = await s.read.getMe();
  assert.equal(me.id, a.userId);
  assert.equal(s.store.stored(), s.issued.refreshToken);
  assert.equal(s.coordinator.getSession().token, s.issued.accessToken);
  assert.match(s.issued.refreshToken, /^[0-9a-f]{96}$/);
});

test('rotation on real PostgreSQL: refresh rotates, the old token is reuse and ends the whole session', async () => {
  const p = await browserRegister('rot');
  const s = await signIn(p);
  const first = s.store.stored();
  const fresh = await s.coordinator.refreshAfterUnauthorized(s.coordinator.getSession());
  assert.ok(fresh);
  const second = s.store.stored();
  assert.notEqual(second, first);
  assert.equal((await s.read.getMe()).id, p.userId);
  // An attacker (or a crashed client) presents the consumed token.
  await assert.rejects(s.authApi.refresh(first), (e) => e.code === 'INVALID_GRANT' && e.reason === 'reuse');
  // Reuse detection revoked the family: the legitimate successor is dead too.
  const after = await s.coordinator.refreshAfterUnauthorized(s.coordinator.getSession());
  assert.equal(after, null);
  assert.equal(s.coordinator.getState().phase, 'signed-out');
  assert.equal(s.store.stored(), null);
});

test('concurrent 401s share ONE rotation on the wire; a raw double-spend on the server has exactly one winner', async () => {
  const p = await browserRegister('conc');
  const s = await signIn(p);
  const before = wire.refresh;
  const failed = s.coordinator.getSession();
  const results = await Promise.all([1, 2, 3, 4].map(() => s.coordinator.refreshAfterUnauthorized(failed)));
  assert.equal(wire.refresh - before, 1);
  assert.equal(new Set(results.map((r) => r.token)).size, 1);

  const q = await browserRegister('race');
  const t = await signIn(q);
  const token = t.store.stored();
  const settled = await Promise.allSettled([t.authApi.refresh(token), t.authApi.refresh(token)]);
  assert.deepEqual(settled.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(settled.find((r) => r.status === 'rejected').reason.reason, 'reuse');
});

test('authorization code: single use, replay revokes its session; wrong verifier burns it', async () => {
  const p = await browserRegister('code');
  const a1 = app();
  const callback = await browserFor(p).start();
  const issued = await a1.authApi.exchangeCode(callback);
  await assert.rejects(a1.authApi.exchangeCode(callback), (e) => e.code === 'INVALID_GRANT');
  await assert.rejects(a1.authApi.refresh(issued.refreshToken), (e) => e.code === 'INVALID_GRANT');

  const cb2 = await browserFor(p).start();
  await assert.rejects(a1.authApi.exchangeCode({ ...cb2, verifier: crypto.randomBytes(32).toString('base64url') }), (e) => e.code === 'INVALID_GRANT');
  await assert.rejects(a1.authApi.exchangeCode(cb2), (e) => e.code === 'INVALID_GRANT');
});

test('state and redirect: unlisted redirect and foreign callbacks are refused', async () => {
  const p = await browserRegister('redir');
  const pk = await createPkceAttempt(nodeCrypto);
  const res = await consent(p, `${ORIGIN}/native-auth?redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${pk.challenge}&code_challenge_method=S256&state=${pk.state}`);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
  // A real code delivered to an app instance that did not start this attempt.
  const delivered = await browserFor(p).start();
  const other = createBrowserSignIn({
    origin: ORIGIN, redirectUri: REDIRECT, createPkce: () => createPkceAttempt(nodeCrypto),
    openAuthSession: async () => ({ type: 'success', url: `${REDIRECT}?code=${delivered.code}&state=${'x'.repeat(22)}` }),
  });
  await assert.rejects(other.start(), (e) => e.code === 'STATE_MISMATCH');
});

test('2FA account: password alone yields no browser session and no code; after the second factor, sign-in works', async () => {
  const p = await browserRegister('tfa');
  const csrf = await (await fetch(`${ORIGIN}/api/csrf-token`, { headers: { Authorization: `Bearer ${p.access}` } })).json();
  const auth = { Authorization: `Bearer ${p.access}`, 'X-CSRF-Token': csrf.token, 'x-bridge-step-up': p.stepUp.grants['account-security'], 'Content-Type': 'application/json' };
  const setupRes = await fetch(`${ORIGIN}/api/2fa/setup`, { method: 'POST', headers: auth, body: '{}' });
  const setup = await setupRes.json();
  assert.equal(setupRes.status, 200, `2fa/setup answered ${setupRes.status} ${setup.error ?? ''}`);
  assert.ok(setup.secret, 'setup returned a secret');
  const verify = await fetch(`${ORIGIN}/api/2fa/verify`, { method: 'POST', headers: auth, body: JSON.stringify({ code: totp(setup.secret) }) });
  const verified = await verify.json();
  assert.equal(verify.status, 200, JSON.stringify(Object.keys(verified)));

  const login = await fetch(`${ORIGIN}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: p.username, password: PASSWORD }) });
  const pending = await login.json();
  assert.equal(login.status, 202);
  assert.equal(refreshCookie(login), null, 'no browser session before the second factor');
  const unauth = { username: p.username, cookie: null };
  const seen = {};
  await assert.rejects(browserFor(unauth, seen).start(), (e) => e.code === 'CANCELLED');
  assert.equal(seen.status, 401);

  const check = await fetch(`${ORIGIN}/api/2fa/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken: pending.tempToken, code: verified.backupCodes[0] }) });
  assert.equal(check.status, 200);
  const completed = { username: p.username, cookie: refreshCookie(check) };
  assert.ok(completed.cookie, 'the second factor created the browser session');
  const s = await signIn(completed);
  assert.equal((await s.read.getMe()).id, p.userId);
});

test('restore after app restart: the stored token is rotated and the account re-validated', async () => {
  const p = await browserRegister('restore');
  const s = await signIn(p);
  const stored = s.store.stored();
  const relaunched = app(s.store);
  const state = await relaunched.coordinator.restore();
  assert.equal(state.phase, 'authenticated');
  assert.equal(state.userId, p.userId);
  assert.notEqual(s.store.stored(), stored);
});

test('logout revokes server-side (confirmed); logout-everywhere from the web ends the native session', async () => {
  const p = await browserRegister('out');
  const s = await signIn(p);
  const token = s.store.stored();
  const out = await s.coordinator.signOut();
  assert.equal(out.serverSignOut, 'confirmed');
  assert.equal(s.store.stored(), null);
  await assert.rejects(s.authApi.refresh(token), (e) => e.code === 'INVALID_GRANT');

  const q = await browserRegister('outall');
  const t = await signIn(q);
  const csrf = await (await fetch(`${ORIGIN}/api/csrf-token`, { headers: { Authorization: `Bearer ${q.access}` } })).json();
  const all = await fetch(`${ORIGIN}/api/logout-all`, { method: 'POST',
    headers: { Authorization: `Bearer ${q.access}`, 'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(all.status, 200);
  await assert.rejects(t.read.getMe(), (e) => e.code === 'AUTH_REQUIRED');
  assert.equal(await t.coordinator.refreshAfterUnauthorized(t.coordinator.getSession()), null);
  assert.equal(t.coordinator.getState().phase, 'signed-out');
});

test('account switch: after B signs in on the same device, reads answer for B only', async () => {
  const a = await browserRegister('swa');
  const b = await browserRegister('swb');
  const s = await signIn(a);
  assert.equal((await s.read.getMe()).id, a.userId);
  const callback = await browserFor(b).start();
  const issued = await s.authApi.exchangeCode(callback);
  const state = await s.coordinator.signIn(issued);
  assert.equal(state.reason, 'ACCOUNT_SWITCHED');
  assert.equal((await s.read.getMe()).id, b.userId);
});

test('the browser never receives a refresh token in JSON; native responses never set cookies', async () => {
  const p = await browserRegister('leak');
  const login = await fetch(`${ORIGIN}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: p.username, password: PASSWORD }) });
  const body = await login.json();
  assert.equal(Object.keys(body).some((k) => /refresh/i.test(k)), false);
  const refreshed = await fetch(`${ORIGIN}/api/refresh`, { method: 'POST', headers: { Cookie: `bridge_refresh=${refreshCookie(login)}` } });
  assert.equal(Object.keys(await refreshed.json()).some((k) => /refresh/i.test(k)), false);

  const pk = await createPkceAttempt(nodeCrypto);
  const res = await consent(p, `${ORIGIN}/native-auth?redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pk.challenge}&code_challenge_method=S256&state=${pk.state}`);
  const code = new URL(res.headers.get('location').replace(/^[^:]+:/, 'x://h')).searchParams.get('code');
  const tok = await fetch(`${ORIGIN}/api/native-auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: pk.verifier, redirect_uri: REDIRECT }) });
  assert.equal(tok.status, 200);
  assert.deepEqual(tok.headers.getSetCookie(), []);
  assert.equal(tok.headers.get('cache-control'), 'no-store');
});
