// REAL-BACKEND: an access token that EXPIRES while the app runs.
// Requires the server to run with a short ACCESS_TOKEN_TTL (BRIDGE_IT_ACCESS_TTL_S, e.g. 10).
// Missing configuration FAILS the run; nothing is skipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { io as socketIo } from 'socket.io-client';
import { createPkceAttempt } from '../src/pkce.mjs';
import { createBrowserSignIn } from '../src/browser-sign-in.mjs';
import { createNativeAuthApi } from '../src/native-auth-api.mjs';
import { createSessionCoordinator } from '../src/session-coordinator.mjs';
import { createNativeCredentialPort } from '../src/native-credential-port.mjs';
import { createBridgeReadApi } from '../src/bridge-read-api.mjs';
import { createBridgeRealtime } from '../src/bridge-realtime.mjs';

const ORIGIN = process.env.BRIDGE_IT_ORIGIN;
const REDIRECT = process.env.BRIDGE_IT_REDIRECT;
const TTL_S = Number(process.env.BRIDGE_IT_ACCESS_TTL_S);
assert.ok(ORIGIN?.startsWith('https://') && REDIRECT, 'BRIDGE_IT_ORIGIN and BRIDGE_IT_REDIRECT are required');
assert.ok(Number.isInteger(TTL_S) && TTL_S > 0 && TTL_S <= 60, 'BRIDGE_IT_ACCESS_TTL_S (server ACCESS_TOKEN_TTL in seconds, <= 60) is required');

const nodeCrypto = {
  randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  sha256: async (s) => new Uint8Array(crypto.createHash('sha256').update(s, 'ascii').digest()),
};
let refreshes = 0;
const countingFetch = (url, init) => { if (String(url).endsWith('/api/native-auth/refresh')) refreshes += 1; return fetch(url, init); };

test('expired access token: the socket handshake is refused, ONE rotation follows, reads reuse it; no sign-out', async () => {
  const username = `nit_ttl_${crypto.randomBytes(3).toString('hex')}`;
  const reg = await fetch(`${ORIGIN}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'ttl-pass-' + crypto.randomBytes(4).toString('hex') }) });
  assert.equal(reg.status, 200);
  let cookie = (reg.headers.getSetCookie().find((l) => l.startsWith('bridge_refresh=')) || '').split(';')[0];
  let secret = null;
  const store = { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, isAvailableAsync: async () => true,
    getItemAsync: async () => secret, setItemAsync: async (_k, v) => { secret = v; }, deleteItemAsync: async () => { secret = null; } };
  const authApi = createNativeAuthApi({ origin: ORIGIN, fetchImpl: countingFetch });
  const coordinator = createSessionCoordinator({ credentials: createNativeCredentialPort({ secureStore: store }), authApi,
    createReadApi: (getSession) => createBridgeReadApi({ origin: ORIGIN, getSession }) });
  const read = createBridgeReadApi({ origin: ORIGIN, getSession: () => coordinator.getSession() });
  const browser = createBrowserSignIn({ origin: ORIGIN, redirectUri: REDIRECT, createPkce: () => createPkceAttempt(nodeCrypto),
    openAuthSession: async (url) => {
      const q = new URL(url).searchParams;
      const res = await fetch(`${ORIGIN}/api/refresh/native-authorize`, { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie },
        body: new URLSearchParams(Object.fromEntries(q.entries())) });
      return res.status === 303 ? { type: 'success', url: res.headers.get('location') } : { type: 'dismiss' };
    } });
  await coordinator.signIn(await authApi.exchangeCode(await browser.start()));
  const userId = coordinator.getState().userId;

  const rt = createBridgeRealtime({ origin: ORIGIN, coordinator, connect: socketIo });
  try {
    rt.start();
    for (let i = 0; i < 100 && rt.getStatus() !== 'online'; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(rt.getStatus(), 'online');
    rt.stop();

    await new Promise((r) => setTimeout(r, (TTL_S + 2) * 1000)); // the access token is now expired
    const expired = coordinator.getSession();
    await assert.rejects(read.getMe(), (e) => e.code === 'AUTH_REQUIRED');
    const before = refreshes;

    // The socket ALONE meets the expiry: its handshake with the expired token is refused,
    // it refreshes once (coordinator single flight) and reconnects with the rotated token.
    rt.start();
    for (let i = 0; i < 150 && rt.getStatus() !== 'online'; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(rt.getStatus(), 'online', 'socket reconnected after the handshake refusal');
    assert.equal(refreshes - before, 1, 'the socket refusal caused exactly one rotation');
    const now = coordinator.getSession();
    assert.notEqual(now.token, expired.token);
    // A read that failed with the OLD token does not rotate again (already replaced).
    const again = await coordinator.refreshAfterUnauthorized(expired);
    assert.equal(again.token, now.token);
    assert.equal(refreshes - before, 1, 'no second rotation');
    assert.equal((await read.getMe()).id, userId);
    assert.equal(coordinator.getState().phase, 'authenticated');
  } finally {
    rt.dispose();
  }
});
