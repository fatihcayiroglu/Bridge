// Session lifecycle contracts. Real credential port + real read API over fakes for
// SecureStore and fetch: NOT Keychain/Keystore or backend acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeCredentialPort } from '../src/native-credential-port.mjs';
import { createBridgeReadApi } from '../src/bridge-read-api.mjs';
import { createSessionCoordinator, SessionError } from '../src/session-coordinator.mjs';

const ORIGIN = 'https://bridge.example';
const TOKEN_A = 'token-for-account-a';
const TOKEN_B = 'token-for-account-b';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

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

/** fetch fake: GET /api/me answers per token; any answer can be held. */
function server(answers) {
  const calls = [];
  const holds = new Map();
  async function fetchImpl(url, init) {
    const token = init.headers.Authorization.replace('Bearer ', '');
    calls.push({ path: new URL(url).pathname, token });
    if (holds.has(token)) await holds.get(token).promise;
    const answer = answers[token] ?? { status: 401, body: { error: 'no' } };
    if (answer.throws) throw new TypeError('Network request failed');
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  }
  return { fetchImpl, calls, holds };
}

function harness({ stored = null, answers = {}, serverLogout = null } = {}) {
  const store = secureStore(stored);
  const net = server(answers);
  const credentials = createNativeCredentialPort({ secureStore: store.native });
  const states = [];
  const coordinator = createSessionCoordinator({
    credentials,
    createReadApi: (getSession) => createBridgeReadApi({ origin: ORIGIN, getSession, fetchImpl: net.fetchImpl }),
    serverLogout,
  });
  coordinator.subscribe((s) => states.push(s));
  const readApi = createBridgeReadApi({ origin: ORIGIN, getSession: () => coordinator.getSession(), fetchImpl: net.fetchImpl });
  return { store, net, coordinator, states, readApi };
}

const me = (id) => ({ status: 200, body: { _id: id, displayName: id } });
const issued = (token, userId) => ({ kind: 'session', token, userId, displayName: '' });

test('no stored credential: signed out, nothing sent to the server', async () => {
  const { coordinator, net } = harness();
  const s = await coordinator.restore();
  assert.equal(s.phase, 'signed-out');
  assert.equal(coordinator.getSession(), null);
  assert.equal(net.calls.length, 0);
});

test('a restored credential is not usable until GET /api/me accepts it', async () => {
  const { coordinator, net } = harness({ stored: TOKEN_A, answers: { [TOKEN_A]: me('user-a') } });
  const hold = deferred(); net.holds.set(TOKEN_A, hold);
  const restoring = coordinator.restore();
  await tick();
  assert.equal(coordinator.getState().phase, 'restoring');
  assert.equal(coordinator.getSession(), null, 'not exposed while unvalidated');
  hold.resolve();
  const s = await restoring;
  assert.equal(s.phase, 'authenticated');
  assert.equal(s.userId, 'user-a');
  assert.deepEqual(coordinator.getSession(), { token: TOKEN_A, epoch: s.epoch });
  assert.deepEqual(net.calls.map((c) => c.path), ['/api/me']);
});

for (const [status, reason] of [[401, 'SESSION_REJECTED'], [403, 'SESSION_REJECTED'], [404, 'ACCOUNT_GONE']]) {
  test(`restore answered ${status}: signed out (${reason}) and the stored credential is deleted`, async () => {
    const { coordinator, store } = harness({ stored: TOKEN_A, answers: { [TOKEN_A]: { status, body: {} } } });
    const s = await coordinator.restore();
    await tick();
    assert.equal(s.phase, 'signed-out');
    assert.equal(s.reason, reason);
    assert.equal(store.stored(), null);
    assert.equal(coordinator.getSession(), null);
  });
}

for (const [answer, reason] of [[{ throws: true }, 'NETWORK_FAILURE'], [{ status: 429, body: {} }, 'RATE_LIMITED'], [{ status: 503, body: {} }, 'SERVER_UNAVAILABLE']]) {
  test(`restore that cannot be checked (${reason}): credential kept, nothing trusted`, async () => {
    const { coordinator, store } = harness({ stored: TOKEN_A, answers: { [TOKEN_A]: answer } });
    const s = await coordinator.restore();
    assert.equal(s.phase, 'unverified');
    assert.equal(s.reason, reason);
    assert.equal(coordinator.getSession(), null);
    assert.equal(store.stored(), TOKEN_A, 'a rate limit or outage is not a sign-out');
  });
}

test('native storage read failure fails closed: no request, nothing deleted', async () => {
  const { coordinator, store, net } = harness({ stored: TOKEN_A });
  store.fail.get = true;
  const s = await coordinator.restore();
  assert.equal(s.phase, 'storage-failed');
  assert.equal(s.reason, 'READ_FAILED');
  assert.equal(net.calls.length, 0);
  assert.equal(coordinator.getSession(), null);
  assert.equal(store.stored(), TOKEN_A);
});

test('a corrupt stored credential is never sent and is removed', async () => {
  const { coordinator, store, net } = harness({ stored: ' padded-token ' });
  const s = await coordinator.restore();
  await tick();
  assert.equal(s.reason, 'CORRUPT_CREDENTIAL');
  assert.equal(net.calls.length, 0);
  assert.equal(store.stored(), null);
});

test('sign-in during a slow restore: the late answer for the old credential changes nothing', async () => {
  // Restore is validating account A's stored token when the user signs in as B.
  const { coordinator, net, store } = harness({ stored: TOKEN_A, answers: { [TOKEN_A]: { status: 401, body: {} } } });
  const hold = deferred(); net.holds.set(TOKEN_A, hold);
  const restoring = coordinator.restore();
  await tick();
  const b = await coordinator.signIn(issued(TOKEN_B, 'user-b'));
  assert.equal(b.phase, 'authenticated');
  hold.resolve(); // A's 401 arrives late
  await restoring;
  await tick();
  assert.equal(coordinator.getState().userId, 'user-b');
  assert.deepEqual(coordinator.getSession(), { token: TOKEN_B, epoch: b.epoch });
  assert.equal(store.stored(), TOKEN_B, "A's late refusal must not delete B's credential");
});

test('a late 200 for a superseded restore cannot authenticate the old account', async () => {
  const { coordinator, net } = harness({ stored: TOKEN_A, answers: { [TOKEN_A]: me('user-a') } });
  const hold = deferred(); net.holds.set(TOKEN_A, hold);
  const restoring = coordinator.restore();
  await tick();
  await coordinator.signOut();
  hold.resolve();
  await restoring;
  assert.equal(coordinator.getState().phase, 'signed-out');
  assert.equal(coordinator.getSession(), null);
});

test('sign-out while a sign-in is still being written: storage ends empty', async () => {
  const { coordinator, store } = harness();
  const hold = deferred(); store.holds.set = hold;
  const signingIn = coordinator.signIn(issued(TOKEN_A, 'user-a'));
  await tick();
  const out = coordinator.signOut();
  hold.resolve();
  await assert.rejects(signingIn, (e) => e instanceof SessionError && e.code === 'SUPERSEDED');
  await out;
  assert.equal(store.stored(), null);
  assert.deepEqual(store.ops.filter((o) => o !== 'get'), ['set', 'delete'], 'clear runs after the write');
  assert.equal(coordinator.getSession(), null);
});

test('account switch: a request sent for A cannot be answered into B', async () => {
  const { coordinator, net, readApi } = harness({ answers: { [TOKEN_A]: me('user-a') } });
  await coordinator.signIn(issued(TOKEN_A, 'user-a'));
  const hold = deferred(); net.holds.set(TOKEN_A, hold);
  const forA = readApi.getMe();
  await tick();
  const b = await coordinator.signIn(issued(TOKEN_B, 'user-b'));
  assert.equal(b.reason, 'ACCOUNT_SWITCHED');
  hold.resolve();
  await assert.rejects(forA, (e) => e.code === 'SESSION_CHANGED');
});

test('sign-in that cannot be stored is not adopted (fail closed)', async () => {
  const { coordinator, store } = harness();
  store.fail.set = true;
  await assert.rejects(coordinator.signIn(issued(TOKEN_A, 'user-a')), (e) => e.code === 'STORAGE_FAILED');
  assert.equal(coordinator.getState().phase, 'storage-failed');
  assert.equal(coordinator.getSession(), null);
});

test('sign-out that cannot delete the credential is reported, and memory is already empty', async () => {
  const { coordinator, store } = harness();
  await coordinator.signIn(issued(TOKEN_A, 'user-a'));
  store.fail.delete = true;
  const s = await coordinator.signOut();
  assert.equal(s.phase, 'storage-failed');
  assert.equal(s.reason, 'CLEAR_FAILED');
  assert.equal(coordinator.getSession(), null);
});

test('only the session that got the 401 can be ended by it', async () => {
  const { coordinator, store } = harness();
  const a = await coordinator.signIn(issued(TOKEN_A, 'user-a'));
  const b = await coordinator.signIn(issued(TOKEN_B, 'user-b'));
  await coordinator.reportAuthFailure(a.epoch); // late 401 from A
  assert.equal(coordinator.getState().userId, 'user-b');
  assert.equal(store.stored(), TOKEN_B);
  const out = await coordinator.reportAuthFailure(b.epoch);
  assert.equal(out.phase, 'signed-out');
  assert.equal(out.reason, 'SESSION_REJECTED');
  assert.equal(store.stored(), null);
});

test('account deletion signs out and removes the credential; server logout failure is irrelevant', async () => {
  let logoutCalls = 0;
  const { coordinator, store } = harness({ serverLogout: async () => { logoutCalls += 1; throw new Error('offline'); } });
  await coordinator.signIn(issued(TOKEN_A, 'user-a'));
  const s = await coordinator.accountDeleted();
  await tick();
  assert.equal(s.reason, 'ACCOUNT_DELETED');
  assert.equal(store.stored(), null);
  assert.equal(logoutCalls, 1);
});

test('epochs only increase, and no emitted state ever carries a token', async () => {
  const { coordinator, states } = harness({ stored: TOKEN_A, answers: { [TOKEN_A]: me('user-a') } });
  await coordinator.restore();
  await coordinator.signIn(issued(TOKEN_B, 'user-b'));
  await coordinator.signOut();
  const epochs = states.map((s) => s.epoch);
  assert.ok(epochs.every((e, i) => i === 0 || e >= epochs[i - 1]));
  assert.ok(new Set(epochs).size >= 3);
  const serialized = JSON.stringify(states) + JSON.stringify(coordinator.getState());
  assert.equal(serialized.includes(TOKEN_A) || serialized.includes(TOKEN_B), false);
});

test('invalid inputs and wiring are refused', () => {
  assert.throws(() => createSessionCoordinator({}), (e) => e.code === 'INVALID_COORDINATOR');
  const { coordinator } = harness();
  return assert.rejects(coordinator.signIn({ kind: 'two-factor', challenge: 'x' }), (e) => e.code === 'INVALID_SESSION');
});

test('a transition forgets the previous account at once: no old user id while the next session is pending', async () => {
  const { coordinator, store, states } = harness();
  await coordinator.signIn(issued(TOKEN_A, 'user-a'));
  const hold = deferred(); store.holds.set = hold;
  const switching = coordinator.signIn(issued(TOKEN_B, 'user-b'));
  await tick();
  const pending = coordinator.getState();
  assert.equal(pending.phase, 'restoring');
  assert.equal(pending.userId, null, "caches keyed by user id must drop A's data now, not after B is stored");
  assert.equal(coordinator.getSession(), null);
  hold.resolve();
  await switching;
  const out = await coordinator.signOut();
  assert.equal(out.userId, null);
  assert.ok(states.filter((s) => s.phase !== 'authenticated').every((s) => s.userId === null));
});
