// Sign-in adapter contracts against fake fetch answers shaped like server/routes/auth.ts
// and twoFactor.ts. NOT a backend integration test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeAuthError, createBridgeAuthApi } from '../src/bridge-auth-api.mjs';

const ORIGIN = 'https://bridge.example';

function harness(...answers) {
  const calls = [];
  const queue = [...answers];
  const api = createBridgeAuthApi({
    origin: ORIGIN,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const a = queue.shift();
      if (a.throws) throw new TypeError('Network request failed');
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.badJson) throw new SyntaxError('x'); return a.body; } };
    },
  });
  return { api, calls };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof BridgeAuthError);
    assert.equal(e.code, code);
    assert.equal(e.message, code, 'no server text or credential in the error');
    return true;
  });
}

test('password sign-in returns the server-issued session; cookies are omitted', async () => {
  const { api, calls } = harness({ status: 200, body: { token: 'access-token', user: { _id: 'u1', displayName: 'Ada' }, stepUp: {} } });
  const s = await api.signInWithPassword('ada', 'correct horse');
  assert.deepEqual(s, { kind: 'session', token: 'access-token', userId: 'u1', displayName: 'Ada' });
  assert.equal(calls[0].url, ORIGIN + '/api/login');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(calls[0].body, { username: 'ada', password: 'correct horse' });
});

test('a 2FA account gets only an opaque challenge, never a token, and completes with /api/2fa/check', async () => {
  const challenge = 'c'.repeat(64);
  const { api, calls } = harness(
    { status: 202, body: { requiresTwoFactor: true, tempToken: challenge } },
    { status: 200, body: { ok: true, token: 'access-token', user: { _id: 'u1' } } },
  );
  const first = await api.signInWithPassword('ada', 'pw');
  assert.deepEqual(first, { kind: 'two-factor', challenge });
  assert.equal('token' in first, false);
  const s = await api.completeTwoFactor(challenge, '123456');
  assert.equal(s.kind, 'session');
  assert.equal(calls[1].url, ORIGIN + '/api/2fa/check');
  assert.deepEqual(calls[1].body, { tempToken: challenge, code: '123456' });
});

test('server refusals are classified without echoing server text', async () => {
  for (const [answer, code] of [
    [{ status: 401, body: { error: 'Invalid username or password' } }, 'INVALID_CREDENTIALS'],
    [{ status: 400, body: { error: 'captcha', requireCaptcha: true } }, 'CAPTCHA_REQUIRED'],
    [{ status: 403, body: { error: 'EMAIL_NOT_VERIFIED' } }, 'EMAIL_NOT_VERIFIED'],
    [{ status: 403, body: { error: 'İstek reddedildi' } }, 'FORBIDDEN'],
    [{ status: 429, body: { locked: true } }, 'RATE_LIMITED'],
    [{ status: 503, body: {} }, 'SERVER_UNAVAILABLE'],
    [{ status: 400, body: { error: 'x' } }, 'REQUEST_REJECTED'],
    [{ throws: true }, 'NETWORK_FAILURE'],
  ]) {
    const { api } = harness(answer);
    await rejectsCode(api.signInWithPassword('ada', 'pw'), code);
  }
});

test('malformed success answers fail closed', async () => {
  for (const answer of [
    { status: 200, body: { token: 'x' } },
    { status: 200, body: { user: { _id: 'u1' } } },
    { status: 200, badJson: true },
    { status: 202, body: { requiresTwoFactor: true } },
    { status: 202, body: { tempToken: 'x'.repeat(64) } },
  ]) {
    const { api } = harness(answer);
    await rejectsCode(api.signInWithPassword('ada', 'pw'), 'BAD_RESPONSE');
  }
});

test('inputs and origin are validated before any request', async () => {
  const { api, calls } = harness();
  await rejectsCode(api.signInWithPassword('', 'pw'), 'INVALID_INPUT');
  await rejectsCode(api.completeTwoFactor('short', ''), 'INVALID_INPUT');
  assert.equal(calls.length, 0);
  assert.throws(() => createBridgeAuthApi({ origin: 'http://bridge.example' }), (e) => e.code === 'INVALID_ORIGIN');
});

test('logout posts without credentials and reports refusals', async () => {
  const { api, calls } = harness({ status: 200, body: { ok: true } }, { status: 503, body: {} });
  await api.logout();
  assert.equal(calls[0].url, ORIGIN + '/api/logout');
  assert.equal(calls[0].init.credentials, 'omit');
  await rejectsCode(api.logout(), 'SERVER_UNAVAILABLE');
});
