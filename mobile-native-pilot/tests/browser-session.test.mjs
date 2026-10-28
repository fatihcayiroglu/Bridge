// Real coordinator and serialized credential port; browser/network/storage
// transports are controlled here. These are race contracts, not native evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeCredentialPort } from '../src/native-credential-port.mjs';
import { createSessionCoordinator } from '../src/session-coordinator.mjs';
import { createBrowserSessionSignIn } from '../src/browser-session.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const issued = userId => ({ userId, accessToken: `access-${userId}`, refreshToken: `refresh-${userId}` });
function fixture() {
  let stored = null;
  const writes = [], revoked = [];
  const credentials = createNativeCredentialPort({ secureStore: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    isAvailableAsync: async () => true,
    getItemAsync: async () => stored,
    setItemAsync: async (_key, value) => { writes.push(value); stored = value; },
    deleteItemAsync: async () => { stored = null; },
  } });
  const authApi = { revoke: async token => { revoked.push(token); }, refresh: async () => { throw Error('unexpected refresh'); } };
  const coordinator = createSessionCoordinator({ credentials, authApi, createReadApi: () => ({ getMe: async () => { throw Error('unexpected read'); } }) });
  return { coordinator, authApi, writes, revoked, stored: () => stored };
}

for (const transition of ['signOut', 'accountDeleted', 'switch']) {
  test(`browser exchange cannot adopt A after ${transition}`, async () => {
    const f = fixture(), requested = deferred(), response = deferred();
    const signIn = createBrowserSessionSignIn({ coordinator: f.coordinator,
      browser: { start: async () => ({ code: 'private-code' }) },
      authApi: { ...f.authApi, exchangeCode: async () => { requested.resolve(); return response.promise; } } });
    const pending = signIn();
    const rejected = assert.rejects(pending, error => error.code === 'SUPERSEDED');
    await requested.promise;
    if (transition === 'switch') await f.coordinator.signIn(issued('B'));
    else await f.coordinator[transition]();
    response.resolve(issued('A'));
    await rejected;
    assert.equal(f.coordinator.getState().userId, transition === 'switch' ? 'B' : null);
    assert.equal(f.stored(), transition === 'switch' ? 'refresh-B' : null);
    assert.ok(!f.writes.includes('refresh-A'));
    assert.ok(f.revoked.includes('refresh-A'));
  });
}

test('a session change while the browser is open prevents any token exchange', async () => {
  const f = fixture(), callback = deferred();
  let exchanges = 0;
  const signIn = createBrowserSessionSignIn({ coordinator: f.coordinator,
    browser: { start: () => callback.promise },
    authApi: { ...f.authApi, exchangeCode: async () => { exchanges++; return issued('A'); } } });
  const pending = signIn();
  const rejected = assert.rejects(pending, error => error.code === 'SUPERSEDED');
  await f.coordinator.signOut();
  callback.resolve({ code: 'private-code' });
  await rejected;
  assert.equal(exchanges, 0);
  assert.equal(f.stored(), null);
});

test('a newer browser request invalidates an older in-flight exchange in the same epoch', async () => {
  const f = fixture(), requested = deferred(), response = deferred(), newerBrowser = deferred();
  let starts = 0;
  const signIn = createBrowserSessionSignIn({ coordinator: f.coordinator,
    browser: { start: async () => ++starts === 1 ? { code: 'A' } : newerBrowser.promise },
    authApi: { ...f.authApi, exchangeCode: async ({ code }) => {
      if (code === 'A') { requested.resolve(); return response.promise; }
      return issued('B');
    } } });
  const first = signIn();
  const rejected = assert.rejects(first, error => error.code === 'SUPERSEDED');
  await requested.promise;
  const second = signIn();
  response.resolve(issued('A'));
  await rejected;
  assert.equal(f.stored(), null);
  newerBrowser.resolve({ code: 'B' });
  assert.equal((await second).userId, 'B');
  assert.deepEqual(f.writes, ['refresh-B']);
  assert.deepEqual(f.revoked, ['refresh-A']);
});

test('normal browser completion persists before exposing the authenticated session', async () => {
  const f = fixture();
  const signIn = createBrowserSessionSignIn({ coordinator: f.coordinator,
    browser: { start: async () => ({ code: 'A' }) },
    authApi: { ...f.authApi, exchangeCode: async () => issued('A') } });
  assert.equal((await signIn()).userId, 'A');
  assert.equal(f.stored(), 'refresh-A');
  assert.equal(f.coordinator.getSession().token, 'access-A');
});

test('a reentrant sign-out during adoption cannot leave the discarded token in storage', async () => {
  const f = fixture();
  let signOut;
  const unsubscribe = f.coordinator.subscribe(state => {
    if (state.phase === 'restoring') { unsubscribe(); signOut = f.coordinator.signOut(); }
  });
  await assert.rejects(f.coordinator.signIn(issued('A')), error => error.code === 'SUPERSEDED');
  await signOut;
  assert.equal(f.coordinator.getSession(), null);
  assert.equal(f.stored(), null);
  assert.ok(!f.writes.includes('refresh-A'));
});

test('failed orphan revocation still refuses A and preserves the newer B credential', async () => {
  const f = fixture(), requested = deferred(), response = deferred();
  const signIn = createBrowserSessionSignIn({ coordinator: f.coordinator,
    browser: { start: async () => ({ code: 'A' }) },
    authApi: { ...f.authApi, exchangeCode: async () => { requested.resolve(); return response.promise; },
      revoke: async () => { throw Error('private-revocation-detail'); } } });
  const pending = signIn();
  const rejected = assert.rejects(pending, error => error.code === 'SUPERSEDED' && !String(error).includes('private'));
  await requested.promise;
  await f.coordinator.signIn(issued('B'));
  response.resolve(issued('A'));
  await rejected;
  assert.equal(f.stored(), 'refresh-B');
  assert.equal(f.coordinator.getState().userId, 'B');
  assert.ok(!f.writes.includes('refresh-A'));
});

test('server rejection of the current session invalidates an in-flight browser exchange', async () => {
  const f = fixture(), requested = deferred(), response = deferred();
  await f.coordinator.signIn(issued('C'));
  const signIn = createBrowserSessionSignIn({ coordinator: f.coordinator,
    browser: { start: async () => ({ code: 'A' }) },
    authApi: { ...f.authApi, exchangeCode: async () => { requested.resolve(); return response.promise; } } });
  const pending = signIn();
  const rejected = assert.rejects(pending, error => error.code === 'SUPERSEDED');
  await requested.promise;
  f.authApi.refresh = async () => { throw Object.assign(Error('rejected'), { code: 'INVALID_GRANT' }); };
  assert.equal(await f.coordinator.refreshAfterUnauthorized(f.coordinator.getSession()), null);
  response.resolve(issued('A'));
  await rejected;
  assert.equal(f.coordinator.getState().phase, 'signed-out');
  assert.equal(f.stored(), null);
  assert.ok(!f.writes.includes('refresh-A'));
});
