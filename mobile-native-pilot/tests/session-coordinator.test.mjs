// Session lifecycle contracts over the REAL credential port, native auth API and
// read API, against a fake Bridge server that implements the server's rotation
// rules (single use, reuse revokes the family, logout revokes) and a SecureStore
// fake whose native calls can be held or failed. NOT Keychain/Keystore, backend
// or device acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeCredentialPort } from '../src/native-credential-port.mjs';
import { createBridgeReadApi } from '../src/bridge-read-api.mjs';
import { createNativeAuthApi } from '../src/native-auth-api.mjs';
import { createSessionCoordinator, SessionError } from '../src/session-coordinator.mjs';

const ORIGIN = 'https://bridge.example';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

/** SecureStore fake whose native calls can be held open and failed. */
function secureStore(initial = null) {
  let secret = initial;
  const ops = [];
  const holds = { get: null, set: null, delete: null };
  const fail = { get: false, set: false, delete: false };
  async function gate(kind) { if (holds[kind]) await holds[kind].promise; if (fail[kind]) throw new Error('native refused: ' + kind); }
  return {
    native: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
      async isAvailableAsync() { return true; },
      async getItemAsync() { ops.push('get'); await gate('get'); return secret; },
      async setItemAsync(_k, value) { ops.push('set'); await gate('set'); secret = value; },
      async deleteItemAsync() { ops.push('delete'); await gate('delete'); secret = null; },
    },
    ops, holds, fail,
    stored: () => secret,
  };
}

/**
 * Fake Bridge server with the server's refresh rules: a refresh token is single
 * use; presenting a used one deletes its whole family (reuse); logout deletes the
 * row; GET /api/me answers for live access tokens.
 */
function bridgeServer() {
  const refresh = new Map();  // token → { user, family, used }
  const access = new Map();   // token → user
  let n = 0;
  const calls = [];
  const holds = { refresh: [], me: [], revoke: [] };
  const offline = { refresh: false, revoke: false, me: false };
  const deletedUsers = new Set();

  function issue(user, family = `fam-${++n}`) {
    const rt = `rt-${user}-${++n}`.padEnd(40, 'x');
    const at = `at-${user}-${++n}`;
    refresh.set(rt, { user, family, used: false });
    access.set(at, user);
    return { rt, at };
  }
  function reply(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }
  async function fetchImpl(url, init) {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/api/native-auth/refresh') {
      const { refresh_token: presented } = JSON.parse(init.body);
      const hold = holds.refresh.shift(); if (hold) await hold.promise;
      if (offline.refresh) throw new TypeError('Network request failed');
      const row = refresh.get(presented);
      if (!row) return reply(401, { error: 'invalid_grant', reason: 'not_found' });
      if (row.used) {
        for (const [k, v] of refresh) if (v.family === row.family) refresh.delete(k);
        return reply(401, { error: 'invalid_grant', reason: 'reuse' });
      }
      row.used = true;
      const next = issue(row.user, row.family);
      const lose = holds.loseRefreshResponse; holds.loseRefreshResponse = false;
      if (lose) throw new TypeError('Network request failed'); // rotated, but the answer is lost
      return reply(200, { token_type: 'Bearer', access_token: next.at, expires_in: 900, refresh_token: next.rt });
    }
    if (path === '/api/refresh/logout') {
      const hold = holds.revoke.shift(); if (hold) await hold.promise;
      if (offline.revoke) throw new TypeError('Network request failed');
      refresh.delete(JSON.parse(init.body).refreshToken);
      return reply(200, { ok: true });
    }
    if (path === '/api/me') {
      const hold = holds.me.shift(); if (hold) await hold.promise;
      if (offline.me) throw new TypeError('Network request failed');
      const user = access.get(init.headers.Authorization.replace('Bearer ', ''));
      if (!user) return reply(401, { error: 'no' });
      if (deletedUsers.has(user)) return reply(404, { error: 'gone' });
      return reply(200, { _id: user, displayName: user });
    }
    return reply(404, {});
  }
  const liveRefresh = (user) => [...refresh.entries()].filter(([, v]) => v.user === user && !v.used).map(([k]) => k);
  return { fetchImpl, issue, calls, holds, offline, deletedUsers, refresh, access, liveRefresh };
}

function harness({ store = secureStore(), server = bridgeServer() } = {}) {
  const credentials = createNativeCredentialPort({ secureStore: store.native });
  const authApi = createNativeAuthApi({ origin: ORIGIN, fetchImpl: server.fetchImpl });
  const states = [];
  const coordinator = createSessionCoordinator({
    credentials,
    authApi,
    createReadApi: (getSession) => createBridgeReadApi({ origin: ORIGIN, getSession, fetchImpl: server.fetchImpl }),
  });
  coordinator.subscribe((s) => states.push(s));
  const readApi = createBridgeReadApi({ origin: ORIGIN, getSession: () => coordinator.getSession(), fetchImpl: server.fetchImpl });
  return { store, server, coordinator, states, readApi };
}

/** What a completed browser sign-in + code exchange hands to the coordinator. */
function exchanged(server, user) {
  const { rt, at } = server.issue(user);
  return { accessToken: at, refreshToken: rt, userId: user };
}

test('normal sign-in: refresh token persisted, access token only in memory', async () => {
  const { coordinator, store, server, states } = harness();
  const issued = exchanged(server, 'user-a');
  const s = await coordinator.signIn(issued);
  assert.equal(s.phase, 'authenticated');
  assert.equal(store.stored(), issued.refreshToken, 'only the refresh token is stored');
  assert.deepEqual(coordinator.getSession(), { token: issued.accessToken, epoch: s.epoch });
  const seen = JSON.stringify(states);
  assert.equal(seen.includes(issued.accessToken) || seen.includes(issued.refreshToken), false);
});

test('restore: the stored token is rotated, the successor stored, the account named, before anything is usable', async () => {
  const server = bridgeServer();
  const first = server.issue('user-a');
  const store = secureStore(first.rt);
  const { coordinator } = harness({ store, server });
  const meHold = deferred(); server.holds.me.push(meHold);
  const restoring = coordinator.restore();
  await tick(6);
  assert.equal(coordinator.getState().phase, 'restoring');
  assert.equal(coordinator.getSession(), null, 'not exposed before the account is named');
  meHold.resolve();
  const s = await restoring;
  assert.equal(s.phase, 'authenticated');
  assert.equal(s.userId, 'user-a');
  assert.notEqual(store.stored(), first.rt, 'successor persisted');
  assert.deepEqual(server.liveRefresh('user-a'), [store.stored()]);
  assert.deepEqual(server.calls, ['/api/native-auth/refresh', '/api/me']);
});

test('expired access token: one 401 → one rotation → the request succeeds with the new token', async () => {
  const { coordinator, server, readApi, store } = harness();
  await coordinator.signIn(exchanged(server, 'user-a'));
  const before = coordinator.getSession();
  server.access.delete(before.token); // expiry
  await assert.rejects(readApi.getMe(), (e) => e.code === 'AUTH_REQUIRED');
  const fresh = await coordinator.refreshAfterUnauthorized(before);
  assert.ok(fresh && fresh.token !== before.token && fresh.epoch === before.epoch);
  assert.equal((await readApi.getMe()).id, 'user-a');
  assert.deepEqual(server.liveRefresh('user-a'), [store.stored()]);
});

test('concurrent 401s share one rotation; a late 401 for a replaced token does not rotate again', async () => {
  const { coordinator, server } = harness();
  await coordinator.signIn(exchanged(server, 'user-a'));
  const failed = coordinator.getSession();
  const hold = deferred(); server.holds.refresh.push(hold);
  const results = [coordinator.refreshAfterUnauthorized(failed), coordinator.refreshAfterUnauthorized(failed), coordinator.refreshAfterUnauthorized(failed)];
  await tick();
  hold.resolve();
  const sessions = await Promise.all(results);
  assert.equal(new Set(sessions.map((s) => s.token)).size, 1);
  const late = await coordinator.refreshAfterUnauthorized(failed);
  assert.equal(late.token, sessions[0].token);
  assert.equal(server.calls.filter((p) => p === '/api/native-auth/refresh').length, 1);
});

test('replayed or revoked refresh token: signed out, stored credential deleted', async () => {
  const server = bridgeServer();
  const { rt } = server.issue('user-a');
  server.refresh.delete(rt); // revoked server-side (logout elsewhere / logout-all)
  const store = secureStore(rt);
  const { coordinator } = harness({ store, server });
  const s = await coordinator.restore();
  assert.equal(s.phase, 'signed-out');
  assert.equal(s.reason, 'SESSION_REJECTED');
  assert.equal(store.stored(), null);
  assert.equal(coordinator.getSession(), null);
});

test('crash between server rotation and local persistence: the next start is reuse → whole session revoked → sign in again', async () => {
  const server = bridgeServer();
  const first = server.issue('user-a');
  const store = secureStore(first.rt);
  const app1 = harness({ store, server });
  store.holds.set = deferred(); // the write never completes: the process dies here
  void app1.coordinator.restore();
  await tick(8);
  assert.equal(server.refresh.get(first.rt)?.used, true, 'server already rotated');
  assert.equal(store.stored(), first.rt, 'device still holds the consumed token');

  const fresh = secureStore(first.rt); // same Keychain contents after relaunch
  const app2 = harness({ store: fresh, server });
  const s = await app2.coordinator.restore();
  assert.equal(s.phase, 'signed-out');
  assert.equal(s.reason, 'SESSION_REUSED');
  assert.equal(fresh.stored(), null);
  assert.deepEqual(server.liveRefresh('user-a'), [], 'reuse detection revoked the never-persisted successor too');
});

test('lost refresh response (outcome unknown): no automatic retry; nothing trusted; the next attempt fails closed as reuse', async () => {
  const server = bridgeServer();
  const first = server.issue('user-a');
  const store = secureStore(first.rt);
  const { coordinator } = harness({ store, server });
  server.holds.loseRefreshResponse = true;
  const s = await coordinator.restore();
  assert.equal(s.phase, 'unverified');
  assert.equal(s.reason, 'OUTCOME_UNKNOWN');
  assert.equal(coordinator.getSession(), null);
  assert.equal(server.calls.filter((p) => p === '/api/native-auth/refresh').length, 1, 'exactly one rotation request');
  const again = await coordinator.restore();
  assert.equal(again.phase, 'signed-out');
  assert.equal(again.reason, 'SESSION_REUSED');
});

test('offline restore before reaching the server keeps the credential for a later start', async () => {
  const server = bridgeServer();
  const first = server.issue('user-a');
  const store = secureStore(first.rt);
  const { coordinator } = harness({ store, server });
  server.offline.refresh = true;
  const s = await coordinator.restore();
  assert.equal(s.phase, 'unverified');
  assert.equal(store.stored(), first.rt);
  server.offline.refresh = false;
  const later = await coordinator.restore();
  assert.equal(later.phase, 'authenticated');
});

test('native storage failure persisting a rotated token: fail closed, successor revoked, nothing usable', async () => {
  const server = bridgeServer();
  const first = server.issue('user-a');
  const store = secureStore(first.rt);
  const { coordinator } = harness({ store, server });
  store.fail.set = true;
  const s = await coordinator.restore();
  await tick(6);
  assert.equal(s.phase, 'storage-failed');
  assert.equal(s.reason, 'WRITE_FAILED');
  assert.equal(coordinator.getSession(), null);
  assert.deepEqual(server.liveRefresh('user-a'), [], 'successor revoked server-side');
  assert.equal(store.stored(), null, 'consumed predecessor removed');
});

test('native storage failure at sign-in: not adopted, issued session revoked', async () => {
  const { coordinator, server, store } = harness();
  store.fail.set = true;
  const issued = exchanged(server, 'user-a');
  await assert.rejects(coordinator.signIn(issued), (e) => e instanceof SessionError && e.code === 'STORAGE_FAILED');
  await tick(6);
  assert.equal(coordinator.getState().phase, 'storage-failed');
  assert.equal(coordinator.getSession(), null);
  assert.deepEqual(server.liveRefresh('user-a'), []);
});

test('storage read failure fails closed: nothing sent, nothing deleted', async () => {
  const server = bridgeServer();
  const store = secureStore('stored-token-value-aaaaaaaaaaaaaaaaaaaaaaa');
  store.fail.get = true;
  const { coordinator } = harness({ store, server });
  const s = await coordinator.restore();
  assert.equal(s.phase, 'storage-failed');
  assert.equal(s.reason, 'READ_FAILED');
  assert.equal(server.calls.length, 0);
  assert.equal(store.ops.includes('delete'), false);
});

test('account switch during a refresh: the late rotation for A is not adopted into B and is revoked', async () => {
  const { coordinator, server, store } = harness();
  await coordinator.signIn(exchanged(server, 'user-a'));
  const failedA = coordinator.getSession();
  const hold = deferred(); server.holds.refresh.push(hold);
  const lateA = coordinator.refreshAfterUnauthorized(failedA);
  await tick();
  const b = exchanged(server, 'user-b');
  const sB = await coordinator.signIn(b);
  assert.equal(sB.reason, 'ACCOUNT_SWITCHED');
  hold.resolve();
  assert.equal(await lateA, null);
  await tick(6);
  assert.deepEqual(coordinator.getSession(), { token: b.accessToken, epoch: sB.epoch });
  assert.equal(store.stored(), b.refreshToken);
  assert.deepEqual(server.liveRefresh('user-a'), [], "A's late successor was revoked");
});

test('cross-account isolation: a read sent for A cannot be answered into B', async () => {
  const { coordinator, server, readApi } = harness();
  await coordinator.signIn(exchanged(server, 'user-a'));
  const hold = deferred(); server.holds.me.push(hold);
  const pendingA = readApi.getMe();
  await tick();
  await coordinator.signIn(exchanged(server, 'user-b'));
  hold.resolve();
  await assert.rejects(pendingA, (e) => e.code === 'SESSION_CHANGED');
  assert.equal((await readApi.getMe()).id, 'user-b');
});

test('logout: local state cleared first, then server revocation confirmed', async () => {
  const { coordinator, server, store, states } = harness();
  const issued = exchanged(server, 'user-a');
  await coordinator.signIn(issued);
  const out = await coordinator.signOut();
  assert.equal(out.phase, 'signed-out');
  assert.equal(out.serverSignOut, 'confirmed');
  assert.equal(store.stored(), null);
  assert.equal(server.refresh.has(issued.refreshToken), false);
  const firstSignedOut = states.find((s) => s.phase === 'signed-out');
  assert.equal(firstSignedOut.serverSignOut, 'pending', 'signed out locally before the server answered');
});

test('logout clears the device before the server is asked: storage empty while revocation is still in flight', async () => {
  const { coordinator, server, store } = harness();
  await coordinator.signIn(exchanged(server, 'user-a'));
  const hold = deferred(); server.holds.revoke.push(hold);
  const out = coordinator.signOut();
  await tick(6);
  assert.equal(store.stored(), null, 'deleted locally before the server answered');
  assert.equal(coordinator.getState().phase, 'signed-out');
  assert.equal(coordinator.getState().serverSignOut, 'pending');
  assert.equal(coordinator.getSession(), null);
  hold.resolve();
  assert.equal((await out).serverSignOut, 'confirmed');
});

test('logout offline: signed out locally, server revocation honestly reported as unconfirmed', async () => {
  const { coordinator, server, store } = harness();
  const issued = exchanged(server, 'user-a');
  await coordinator.signIn(issued);
  server.offline.revoke = true;
  const out = await coordinator.signOut();
  assert.equal(out.phase, 'signed-out');
  assert.equal(out.serverSignOut, 'unconfirmed');
  assert.equal(store.stored(), null);
  assert.equal(coordinator.getSession(), null);
});

test('logout during a refresh: storage ends empty and the late successor is revoked', async () => {
  const { coordinator, server, store } = harness();
  await coordinator.signIn(exchanged(server, 'user-a'));
  const hold = deferred(); server.holds.refresh.push(hold);
  const late = coordinator.refreshAfterUnauthorized(coordinator.getSession());
  await tick();
  const out = coordinator.signOut();
  hold.resolve();
  assert.equal(await late, null);
  await out;
  await tick(6);
  assert.equal(store.stored(), null);
  assert.deepEqual(server.liveRefresh('user-a'), []);
});

test('sign-in while a slow restore is writing: storage ends with the new account', async () => {
  const server = bridgeServer();
  const old = server.issue('user-a');
  const store = secureStore(old.rt);
  const { coordinator } = harness({ store, server });
  const writeHold = deferred(); store.holds.set = writeHold;
  const restoring = coordinator.restore();
  await tick(8);
  store.holds.set = null;
  const b = exchanged(server, 'user-b');
  const signing = coordinator.signIn(b);
  writeHold.resolve();
  await restoring;
  await signing;
  await tick(6);
  assert.equal(store.stored(), b.refreshToken);
  assert.equal(coordinator.getState().userId, 'user-b');
  assert.deepEqual(server.liveRefresh('user-a'), [], "the restore's successor was revoked");
});

test('restore of a deleted account (404 from /api/me): signed out as ACCOUNT_GONE', async () => {
  const server = bridgeServer();
  const first = server.issue('user-a');
  server.deletedUsers.add('user-a');
  const store = secureStore(first.rt);
  const { coordinator } = harness({ store, server });
  const s = await coordinator.restore();
  assert.equal(s.reason, 'ACCOUNT_GONE');
  assert.equal(store.stored(), null);
});

test('a corrupt stored credential is never sent and is removed', async () => {
  const server = bridgeServer();
  const store = secureStore(' padded ');
  const { coordinator } = harness({ store, server });
  const s = await coordinator.restore();
  assert.equal(s.reason, 'CORRUPT_CREDENTIAL');
  assert.equal(server.calls.length, 0);
  assert.equal(store.stored(), null);
});

test('account deletion signs out and clears; epochs only increase; no state carries a token', async () => {
  const { coordinator, server, states } = harness();
  const a = exchanged(server, 'user-a');
  await coordinator.signIn(a);
  await coordinator.refreshAfterUnauthorized(coordinator.getSession());
  const out = await coordinator.accountDeleted();
  assert.equal(out.reason, 'ACCOUNT_DELETED');
  const epochs = states.map((s) => s.epoch);
  assert.deepEqual(epochs, [...epochs].sort((x, y) => x - y));
  const text = JSON.stringify(states);
  for (const t of [...server.refresh.keys(), ...server.access.keys(), a.accessToken, a.refreshToken]) assert.equal(text.includes(t), false);
});

test('a transition forgets the previous account at once', async () => {
  const { coordinator, server, store } = harness();
  await coordinator.signIn(exchanged(server, 'user-a'));
  store.holds.set = deferred();
  const pending = coordinator.signIn(exchanged(server, 'user-b'));
  await tick();
  assert.equal(coordinator.getState().userId, null);
  assert.equal(coordinator.getSession(), null);
  store.holds.set.resolve();
  await pending;
});

test('invalid inputs and wiring are refused', async () => {
  const { coordinator } = harness();
  await assert.rejects(coordinator.signIn({ accessToken: 'x', userId: 'u' }), (e) => e.code === 'INVALID_SESSION');
  assert.throws(() => createSessionCoordinator({}), (e) => e.code === 'INVALID_COORDINATOR');
});
