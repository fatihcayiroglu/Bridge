// PKCE, browser-callback validation and native token API contracts, with node:crypto
// standing in for expo-crypto and a fake openAuthSession / fetch. NOT a system-browser,
// Custom Tabs, ASWebAuthenticationSession or backend test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { base64Url, createPkceAttempt } from '../src/pkce.mjs';
import { BrowserSignInError, createBrowserSignIn } from '../src/browser-sign-in.mjs';
import { NativeAuthError, createNativeAuthApi } from '../src/native-auth-api.mjs';

const ORIGIN = 'https://bridge.example';
const REDIRECT = 'com.bridge.app:/oauth';
const nodeCrypto = {
  randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  sha256: async (s) => new Uint8Array(crypto.createHash('sha256').update(s, 'ascii').digest()),
};
const CODE = 'c'.repeat(43);

test('base64url matches Node for every tail length', () => {
  for (let len = 0; len < 40; len += 1) {
    const bytes = new Uint8Array(crypto.randomBytes(len));
    assert.equal(base64Url(bytes), Buffer.from(bytes).toString('base64url'));
  }
});

test('PKCE: 43-char verifier, challenge = BASE64URL(SHA256(verifier)), fresh values per attempt', async () => {
  const a = await createPkceAttempt(nodeCrypto);
  const b = await createPkceAttempt(nodeCrypto);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url'));
  assert.match(a.state, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
  await assert.rejects(createPkceAttempt({ randomBytes: () => new Uint8Array(4), sha256: nodeCrypto.sha256 }));
});

function browser(answer) {
  const opened = [];
  let attempt;
  const signIn = createBrowserSignIn({
    origin: ORIGIN,
    redirectUri: REDIRECT,
    createPkce: async () => (attempt = await createPkceAttempt(nodeCrypto)),
    openAuthSession: async (url, redirect) => { opened.push({ url, redirect }); return answer(attempt); },
  });
  return { signIn, opened, attempt: () => attempt };
}

test('opens the Bridge web consent with S256 and returns code + verifier for the matching callback', async () => {
  const { signIn, opened, attempt } = browser((a) => ({ type: 'success', url: `${REDIRECT}?code=${CODE}&state=${a.state}` }));
  const result = await signIn.start();
  const url = new URL(opened[0].url);
  assert.equal(url.origin + url.pathname, ORIGIN + '/native-auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    redirect_uri: REDIRECT, code_challenge: attempt().challenge, code_challenge_method: 'S256', state: attempt().state,
  });
  assert.equal(opened[0].redirect, REDIRECT);
  assert.deepEqual(result, { code: CODE, verifier: attempt().verifier, redirectUri: REDIRECT });
  assert.equal(signIn.hasPendingAttempt(), false);
});

test('callback validation: injected/foreign codes, wrong addresses, denial and cancel are refused', async () => {
  const cases = [
    [() => ({ type: 'success', url: `${REDIRECT}?code=${CODE}&state=${'x'.repeat(22)}` }), 'STATE_MISMATCH'],
    [() => ({ type: 'success', url: `${REDIRECT}?code=${CODE}` }), 'STATE_MISMATCH'],
    [(a) => ({ type: 'success', url: `${REDIRECT}?code=${CODE}&state=${a.state}&state=${a.state}` }), 'BAD_CALLBACK'],
    [(a) => ({ type: 'success', url: `com.evil.app:/oauth?code=${CODE}&state=${a.state}` }), 'BAD_CALLBACK'],
    [(a) => ({ type: 'success', url: `${REDIRECT}x?code=${CODE}&state=${a.state}` }), 'BAD_CALLBACK'],
    [(a) => ({ type: 'success', url: `${REDIRECT}?code=${CODE}&state=${a.state}#frag` }), 'BAD_CALLBACK'],
    [(a) => ({ type: 'success', url: `${REDIRECT}?code=short&state=${a.state}` }), 'BAD_CALLBACK'],
    [(a) => ({ type: 'success', url: `${REDIRECT}?error=access_denied&state=${a.state}` }), 'DENIED'],
    [() => ({ type: 'cancel' }), 'CANCELLED'],
    [() => ({ type: 'dismiss' }), 'CANCELLED'],
  ];
  for (const [answer, code] of cases) {
    const { signIn } = browser(answer);
    await assert.rejects(signIn.start(), (e) => e instanceof BrowserSignInError && e.code === code, code);
  }
});

test('a newer attempt supersedes an older one; the older callback is never accepted', async () => {
  const pending = [];
  const attempts = [];
  const signIn = createBrowserSignIn({
    origin: ORIGIN, redirectUri: REDIRECT,
    createPkce: async () => { const a = await createPkceAttempt(nodeCrypto); attempts.push(a); return a; },
    openAuthSession: () => new Promise((resolve) => pending.push(resolve)),
  });
  const first = signIn.start();
  await new Promise((r) => setImmediate(r));
  const second = signIn.start();
  await new Promise((r) => setImmediate(r));
  pending[0]({ type: 'success', url: `${REDIRECT}?code=${CODE}&state=${attempts[0].state}` });
  await assert.rejects(first, (e) => e.code === 'SUPERSEDED');
  pending[1]({ type: 'success', url: `${REDIRECT}?code=${CODE}&state=${attempts[1].state}` });
  assert.equal((await second).verifier, attempts[1].verifier);
});

test('adapter rejects non-https origins and redirect addresses carrying a query or fragment', () => {
  const base = { createPkce: async () => ({}), openAuthSession: async () => ({}) };
  assert.throws(() => createBrowserSignIn({ ...base, origin: 'http://bridge.example', redirectUri: REDIRECT }), (e) => e.code === 'INVALID_ORIGIN');
  assert.throws(() => createBrowserSignIn({ ...base, origin: ORIGIN, redirectUri: REDIRECT + '?x=1' }), (e) => e.code === 'INVALID_ADAPTER');
});

function api(...answers) {
  const calls = [];
  const queue = [...answers];
  const client = createNativeAuthApi({
    origin: ORIGIN,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const a = queue.shift();
      if (a.throws) throw new TypeError('Network request failed');
      return { status: a.status, json: async () => a.body };
    },
  });
  return { client, calls };
}
const tokens = { token_type: 'Bearer', access_token: 'at', refresh_token: 'rt', expires_in: 900 };

test('code exchange posts the verifier without cookies and returns tokens + account', async () => {
  const { client, calls } = api({ status: 200, body: { ...tokens, user: { _id: 'u1' } } });
  const r = await client.exchangeCode({ code: CODE, verifier: 'v'.repeat(43), redirectUri: REDIRECT });
  assert.deepEqual(r, { accessToken: 'at', refreshToken: 'rt', expiresIn: 900, userId: 'u1' });
  assert.equal(calls[0].url, ORIGIN + '/api/native-auth/token');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(calls[0].body, { grant_type: 'authorization_code', code: CODE, code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT });
});

test('refresh classification: invalid_grant carries the reason; a lost answer is OUTCOME_UNKNOWN, not a failure', async () => {
  for (const [answer, code, reason] of [
    [{ status: 401, body: { error: 'invalid_grant', reason: 'reuse' } }, 'INVALID_GRANT', 'reuse'],
    [{ status: 401, body: { error: 'invalid_grant', reason: 'something-else' } }, 'INVALID_GRANT', null],
    [{ status: 400, body: { error: 'invalid_request' } }, 'INVALID_REQUEST', null],
    [{ status: 429, body: {} }, 'RATE_LIMITED', null],
    [{ status: 503, body: {} }, 'OUTCOME_UNKNOWN', null],
    [{ throws: true }, 'OUTCOME_UNKNOWN', null],
    [{ status: 200, body: { token_type: 'Bearer', access_token: 'at' } }, 'BAD_RESPONSE', null],
  ]) {
    const { client } = api(answer);
    await assert.rejects(client.refresh('rt'), (e) => e instanceof NativeAuthError && e.code === code && e.reason === reason && e.message === code);
  }
  const { client, calls } = api({ status: 200, body: tokens });
  assert.equal((await client.refresh('old')).refreshToken, 'rt');
  assert.deepEqual(calls[0].body, { refresh_token: 'old' });
});

test('revocation uses the existing /api/refresh/logout body contract; failures are reported, not hidden', async () => {
  const { client, calls } = api({ status: 200, body: { ok: true } }, { throws: true });
  await client.revoke('rt');
  assert.equal(calls[0].url, ORIGIN + '/api/refresh/logout');
  assert.deepEqual(calls[0].body, { refreshToken: 'rt' });
  await assert.rejects(client.revoke('rt'), (e) => e.code === 'NETWORK_FAILURE');
});
