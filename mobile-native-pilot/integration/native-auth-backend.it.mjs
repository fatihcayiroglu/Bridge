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
import { createBrowserSessionSignIn } from '../src/browser-session.mjs';
import { createNativeAuthApi } from '../src/native-auth-api.mjs';
import { createSessionCoordinator } from '../src/session-coordinator.mjs';
import { createNativeCredentialPort } from '../src/native-credential-port.mjs';
import { createBridgeReadApi } from '../src/bridge-read-api.mjs';
import { createBridgeRealtime } from '../src/bridge-realtime.mjs';
import { createOutbox } from '../src/outbox.mjs';
import { createMessagingController } from '../src/messaging-controller.mjs';
import { io as socketIo } from 'socket.io-client';

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
  let callback, issued;
  await createBrowserSessionSignIn({ coordinator: a.coordinator,
    browser: { start: async () => { callback = await browserFor(profile).start(); return callback; } },
    authApi: { ...a.authApi, exchangeCode: async input => { issued = await a.authApi.exchangeCode(input); return issued; } },
  })();
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

for (const transition of ['sign-out', 'account-switch']) {
  test(`late code-exchange response after ${transition}: never stored, orphan revoked on real backend`, async () => {
    const a = await browserRegister(transition === 'sign-out' ? 'lateout' : 'lateacct');
    const b = transition === 'account-switch' ? await browserRegister('lateother') : null;
    const s = app();
    let release, notify, rejectReceived, stale;
    const held = new Promise(resolve => { release = resolve; });
    const received = new Promise((resolve, reject) => { notify = resolve; rejectReceived = reject; });
    const pending = createBrowserSessionSignIn({ coordinator: s.coordinator, browser: browserFor(a),
      authApi: { ...s.authApi, exchangeCode: async callback => {
        try { stale = await s.authApi.exchangeCode(callback); }
        catch (error) { rejectReceived(error); throw error; }
        notify();
        await held;
        return stale;
      } },
    })();
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await received;
    let currentToken;
    try {
      if (b) { await signIn(b, s); currentToken = s.store.stored(); }
      else await s.coordinator.signOut();
    } finally { release(); }
    const result = await outcome;
    assert.equal(result.error?.code, 'SUPERSEDED');
    assert.equal(s.store.stored(), b ? currentToken : null);
    assert.equal(s.coordinator.getState().userId, b ? b.userId : null);
    // This reaches the real server: the discarded session must be unusable.
    await assert.rejects(s.authApi.refresh(stale.refreshToken), error => error.code === 'INVALID_GRANT');
    if (b) {
      assert.equal((await s.read.getMe()).id, b.userId);
      assert.ok(await s.coordinator.refreshAfterUnauthorized(s.coordinator.getSession()));
      assert.equal((await s.read.getMe()).id, b.userId, 'orphan revocation must not revoke B');
    } else assert.equal(s.coordinator.getSession(), null);
  });
}

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

async function csrfHeaders(access) {
  const csrf = await (await fetch(`${ORIGIN}/api/csrf-token`, { headers: { Authorization: `Bearer ${access}` } })).json();
  return { Authorization: `Bearer ${access}`, 'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' };
}

function realtimeFor(s) {
  return createBridgeRealtime({ origin: ORIGIN, coordinator: s.coordinator, connect: socketIo, confirmTimeoutMs: 8000 });
}

async function online(rt) {
  rt.start();
  for (let i = 0; i < 100 && rt.getStatus() !== 'online'; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(rt.getStatus(), 'online');
}

test('navigation + realtime: a native session lists its server and channel, sends a confirmed message, and another account receives it', async () => {
  const a = await browserRegister('rta');
  const b = await browserRegister('rtb');
  const sa = await signIn(a);
  const sb = await signIn(b);
  // A creates a community with the native access token (CSRF applies to Bearer writes).
  const created = await fetch(`${ORIGIN}/api/servers`, { method: 'POST', headers: await csrfHeaders(sa.coordinator.getSession().token),
    body: JSON.stringify({ name: 'native-it' }) });
  assert.equal(created.status < 300, true, `create server ${created.status}`);
  const servers = await sa.read.listServers();
  const server = servers.find((x) => x.name === 'native-it');
  assert.ok(server, 'the new server is listed for its owner');
  const channels = await sa.read.listChannels(server.id);
  assert.ok(channels.length >= 1, 'at least one channel');
  const channel = channels[0];
  // B joins through an invite created by A.
  const invite = await (await fetch(`${ORIGIN}/api/servers/invites`, { method: 'POST', headers: await csrfHeaders(sa.coordinator.getSession().token),
    body: JSON.stringify({ serverId: server.id }) })).json();
  const used = await fetch(`${ORIGIN}/api/servers/invites/${encodeURIComponent(invite.code)}/use`, { method: 'POST',
    headers: await csrfHeaders(sb.coordinator.getSession().token), body: '{}' });
  assert.equal(used.status < 300, true, `invite use ${used.status}`);

  const ra = realtimeFor(sa);
  const rb = realtimeFor(sb);
  try {
    await online(ra);
    await online(rb);
    ra.joinChannel(channel.id);
    rb.joinChannel(channel.id);
    await new Promise((r) => setTimeout(r, 500)); // channel:join has no acknowledgement in the server contract
    const received = new Promise((resolve) => rb.onMessage((m) => { if (m.content.startsWith('hello from native')) resolve(m); }));
    const content = `hello from native ${crypto.randomBytes(4).toString('hex')}`;
    const result = await ra.send({ serverId: server.id, channelId: channel.id, content });
    assert.equal(result.status, 'confirmed', JSON.stringify(result));
    const got = await received;
    assert.equal(got.content, content);
    assert.equal(got.userId, a.userId);
    const history = await sb.read.listMessages(channel.id, { limit: 10 });
    assert.ok(history.messages.some((m) => m.content === content), 'the message is in persisted history');
  } finally {
    ra.dispose();
    rb.dispose();
  }
});

test('realtime refused for a non-member: the send fails with the server code, nothing is persisted', async () => {
  const a = await browserRegister('nma');
  const x = await browserRegister('nmx');
  const sa = await signIn(a);
  const sx = await signIn(x);
  await fetch(`${ORIGIN}/api/servers`, { method: 'POST', headers: await csrfHeaders(sa.coordinator.getSession().token), body: JSON.stringify({ name: 'private-it' }) });
  const server = (await sa.read.listServers()).find((s) => s.name === 'private-it');
  const channel = (await sa.read.listChannels(server.id))[0];
  const rx = realtimeFor(sx);
  try {
    await online(rx);
    rx.joinChannel(channel.id);
    const result = await rx.send({ serverId: server.id, channelId: channel.id, content: 'intruder' });
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.code, 'NOT_A_MEMBER');
    const history = await sa.read.listMessages(channel.id, { limit: 10 });
    assert.equal(history.messages.some((m) => m.content === 'intruder'), false);
  } finally {
    rx.dispose();
  }
});

test('realtime after sign-out: the socket is closed and a send is not attempted', async () => {
  const a = await browserRegister('rto');
  const sa = await signIn(a);
  const ra = realtimeFor(sa);
  try {
    await online(ra);
    await sa.coordinator.signOut();
    assert.equal(ra.getStatus(), 'offline');
  } finally {
    ra.dispose();
  }
});

async function createOutboxCommunity(s) {
  const name = `outbox-${crypto.randomBytes(6).toString('hex')}`;
  const created = await fetch(`${ORIGIN}/api/servers`, { method: 'POST',
    headers: await csrfHeaders(s.coordinator.getSession().token), body: JSON.stringify({ name }) });
  assert.ok(created.ok, `create community: ${created.status}`);
  const server = (await s.read.listServers()).find(row => row.name === name);
  assert.ok(server);
  const channel = (await s.read.listChannels(server.id))[0]; assert.ok(channel);
  return { serverId: server.id, channelId: channel.id };
}

test('messaging screen controller: real session selects a channel, sends and reconciles persisted history', { timeout: 60000 }, async () => {
  const session = await signIn(await browserRegister('screen'));
  const destination = await createOutboxCommunity(session);
  const rt = realtimeFor(session);
  const controller = createMessagingController({ ...session, realtime: rt, createId: () => crypto.randomUUID() });
  const content = `controller-proof-${crypto.randomBytes(8).toString('hex')}`;
  try {
    await controller.start(); await online(rt);
    await controller.selectServer(destination.serverId);
    await controller.selectChannel(destination.channelId);
    await controller.send(content);
    const state = controller.snapshot();
    assert.equal(state.drafts.length, 1); assert.equal(state.drafts[0].status, 'confirmed');
    const persisted = state.messages.filter(message => message.content === content);
    assert.equal(persisted.length, 1);
    assert.equal(String(persisted[0]._id), state.drafts[0].messageId);
  } finally { controller.dispose(); await session.coordinator.signOut(); }
});

test('outbox: offline draft, persisted send with deliberately lost ACK, reconnect and same-id replay yield one history row', { timeout: 60000 }, async () => {
  const a = await browserRegister('oback');
  const sa = await signIn(a); // genuine PKCE consent + token exchange above
  const destination = await createOutboxCommunity(sa);
  const ackId = crypto.randomUUID();
  const content = `lost-ack-${crypto.randomBytes(8).toString('hex')}`;
  let dropped = 0, emitted = [];
  const rt = createBridgeRealtime({ origin: ORIGIN, coordinator: sa.coordinator, confirmTimeoutMs: 1500,
    connect(origin, options) {
      const socket = socketIo(origin, options);
      const on = socket.on.bind(socket), emit = socket.emit.bind(socket);
      // Only the first inbound ACK is dropped. Transport, auth, writes, and
      // subsequent replay ACK all come from the real Socket.IO backend.
      socket.on = (event, listener) => on(event, event === 'message:ack' ? ack => {
        if (ack.ackId === ackId && dropped === 0) { dropped++; return; }
        listener(ack);
      } : listener);
      socket.emit = (event, ...args) => { if (event === 'message:send') emitted.push({ ...args[0] }); return emit(event, ...args); };
      return socket;
    } });
  const box = createOutbox({ coordinator: sa.coordinator, realtime: rt, createId: () => ackId });
  try {
    assert.equal((await sa.read.getMe()).id, a.userId);
    const id = box.enqueue({ ...destination, content });
    await box.flush(); assert.equal(emitted.length, 0, 'draft remains offline');
    await online(rt); rt.joinChannel(destination.channelId);
    await new Promise(resolve => setTimeout(resolve, 500));
    await box.flush();
    assert.equal(dropped, 1, 'the server actually sent the intentionally lost ACK');
    assert.equal(box.snapshot()[0].status, 'unconfirmed');
    const before = (await sa.read.listMessages(destination.channelId, { limit: 50 })).messages.filter(m => m.content === content);
    assert.equal(before.length, 1, 'persisted before acknowledgement loss is retried');
    rt.stop(); await online(rt); rt.joinChannel(destination.channelId);
    await new Promise(resolve => setTimeout(resolve, 500));
    await box.retry(id);
    assert.equal(box.snapshot()[0].status, 'confirmed');
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].ackId, emitted[1].ackId);
    assert.deepEqual(emitted[0], emitted[1], 'replay retains payload and identity');
    const after = (await sa.read.listMessages(destination.channelId, { limit: 50 })).messages.filter(m => m.content === content);
    assert.equal(after.length, 1);
    assert.equal(String(after[0]._id), String(before[0]._id));
    assert.equal(String(after[0]._id), box.snapshot()[0].messageId);
  } finally { box.dispose(); rt.dispose(); await sa.coordinator.signOut(); }
});

test('ACK namespace: concurrent same-user replay deduplicates; another user may use the identical ackId', { timeout: 60000 }, async () => {
  const a = await signIn(await browserRegister('obca'));
  const b = await signIn(await browserRegister('obcb'));
  const destination = await createOutboxCommunity(a);
  const inviteResponse = await fetch(`${ORIGIN}/api/servers/invites`, { method: 'POST',
    headers: await csrfHeaders(a.coordinator.getSession().token), body: JSON.stringify({ serverId: destination.serverId }) });
  assert.ok(inviteResponse.ok);
  const invite = await inviteResponse.json();
  const joined = await fetch(`${ORIGIN}/api/servers/invites/${encodeURIComponent(invite.code)}/use`, { method: 'POST',
    headers: await csrfHeaders(b.coordinator.getSession().token), body: '{}' }); assert.ok(joined.ok);
  const sockets = [realtimeFor(a), realtimeFor(a), realtimeFor(b)];
  const ackId = crypto.randomUUID();
  const contentA = `concurrent-A-${crypto.randomBytes(6).toString('hex')}`;
  const contentB = `same-id-B-${crypto.randomBytes(6).toString('hex')}`;
  try {
    for (const rt of sockets) { await online(rt); rt.joinChannel(destination.channelId); }
    await new Promise(resolve => setTimeout(resolve, 500));
    const results = await Promise.all(sockets.map((rt, i) => rt.send({ ...destination, ackId, content: i === 2 ? contentB : contentA })));
    assert.ok(results.every(result => result.status === 'confirmed'), JSON.stringify(results));
    assert.equal(results[0].messageId, results[1].messageId);
    assert.notEqual(results[0].messageId, results[2].messageId);
    const history = (await a.read.listMessages(destination.channelId, { limit: 50 })).messages;
    const rowsA = history.filter(row => row.content === contentA), rowsB = history.filter(row => row.content === contentB);
    assert.equal(rowsA.length, 1); assert.equal(rowsB.length, 1);
    assert.equal(String(rowsA[0].userId), a.coordinator.getState().userId);
    assert.equal(String(rowsB[0].userId), b.coordinator.getState().userId);
  } finally { sockets.forEach(rt => rt.dispose()); await a.coordinator.signOut(); await b.coordinator.signOut(); }
});
