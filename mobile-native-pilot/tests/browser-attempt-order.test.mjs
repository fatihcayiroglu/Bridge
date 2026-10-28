import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserSignIn } from '../src/browser-sign-in.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const redirect = 'com.bridge.nativepilot:/oauth';
const attempt = tag => ({ challenge: tag.repeat(43), state: tag.repeat(43), verifier: tag.repeat(43) });
const success = tag => ({ type: 'success', url: `${redirect}?code=${'c'.repeat(43)}&state=${tag.repeat(43)}` });

test('a slower older PKCE operation cannot open a browser after the newer request', async () => {
  const oldPkce = deferred(), newBrowser = deferred(), opened = deferred();
  let preparations = 0, opens = 0;
  const browser = createBrowserSignIn({ origin: 'https://bridge.example', redirectUri: redirect,
    createPkce: () => ++preparations === 1 ? oldPkce.promise : Promise.resolve(attempt('b')),
    openAuthSession: async () => { opens++; opened.resolve(); return newBrowser.promise; } });
  const first = browser.start();
  const firstResult = first.then(value => ({ value }), error => ({ error }));
  const second = browser.start();
  await opened.promise;
  oldPkce.resolve(attempt('a'));
  await new Promise(resolve => setImmediate(resolve));
  newBrowser.resolve(success('b'));
  const [older, newer] = await Promise.all([firstResult, second]);
  assert.equal(opens, 1);
  assert.equal(older.error?.code, 'SUPERSEDED');
  assert.equal(newer.verifier, 'b'.repeat(43));
  assert.equal(browser.hasPendingAttempt(), false);
});

test('PKCE preparation is pending immediately and a preparation failure is sanitized', async () => {
  const pending = deferred();
  const browser = createBrowserSignIn({ origin: 'https://bridge.example', redirectUri: redirect,
    createPkce: () => pending.promise, openAuthSession: async () => { throw Error('must not open'); } });
  const first = browser.start();
  const result = first.then(value => ({ value }), error => ({ error }));
  const wasPending = browser.hasPendingAttempt();
  pending.reject(Error('private-native-value'));
  const { error } = await result;
  assert.equal(wasPending, true);
  assert.equal(error?.code, 'PKCE_FAILED');
  assert.ok(!String(error).includes('private-native-value'));
  assert.equal(browser.hasPendingAttempt(), false);
});

test('an older preparation failure cannot clear a newer pending browser request', async () => {
  const oldPkce = deferred(), newBrowser = deferred(), opened = deferred();
  let preparations = 0;
  const browser = createBrowserSignIn({ origin: 'https://bridge.example', redirectUri: redirect,
    createPkce: () => ++preparations === 1 ? oldPkce.promise : Promise.resolve(attempt('b')),
    openAuthSession: async () => { opened.resolve(); return newBrowser.promise; } });
  const first = browser.start();
  const firstResult = first.then(value => ({ value }), error => ({ error }));
  const second = browser.start();
  await opened.promise;
  oldPkce.reject(Error('old-private-error'));
  const older = await firstResult;
  const wasPending = browser.hasPendingAttempt();
  newBrowser.resolve(success('b'));
  assert.equal((await second).verifier, 'b'.repeat(43));
  assert.equal(older.error?.code, 'SUPERSEDED');
  assert.equal(wasPending, true);
});
