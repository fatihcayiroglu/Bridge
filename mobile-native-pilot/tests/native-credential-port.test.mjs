// Offline-only fake SecureStore tests. NOT Keychain/Keystore device acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NativeCredentialError,
  NATIVE_PILOT_CREDENTIAL_KEY,
  createNativeCredentialPort,
} from '../src/native-credential-port.mjs';

function fixture() {
  const calls = [];
  let secret = null;
  const native = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, // Expo SDK 57 exposes this enum as a number.
    async isAvailableAsync() { calls.push(['available']); return true; },
    async getItemAsync(key, options) {
      calls.push(['get', key, options]);
      return secret;
    },
    async setItemAsync(key, value, options) {
      calls.push(['set', key, options]);
      secret = value;
    },
    async deleteItemAsync(key, options) {
      calls.push(['delete', key, options]);
      secret = null;
    },
  };
  return { native, calls, getSecret: () => secret };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof NativeCredentialError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('secure credential capability reads, writes and clears on an isolated key', async () => {
  const { native, calls, getSecret } = fixture();
  const port = createNativeCredentialPort({ secureStore: native });
  assert.equal(await port.readToken(), null);
  await port.writeToken('ephemeral-pilot-test-token');
  assert.equal(getSecret(), 'ephemeral-pilot-test-token');
  assert.equal(await port.readToken(), 'ephemeral-pilot-test-token');
  await port.clearToken();
  assert.equal(getSecret(), null);
  assert.equal(await port.readToken(), null);
  const operations = calls.filter((event) => event[0] !== 'available');
  assert.deepEqual(operations.map((event) => event[0]), ['get', 'set', 'get', 'delete', 'get']);
  assert.ok(operations.every((event) => event[1] === NATIVE_PILOT_CREDENTIAL_KEY));
  assert.ok(operations.every((event) =>
    event[2].keychainAccessible === native.WHEN_UNLOCKED_THIS_DEVICE_ONLY &&
    event[2].requireAuthentication === false));
  assert.equal(JSON.stringify(Object.keys(port)).includes('ephemeral-pilot-test-token'), false);
});

test('missing native methods or platform constant cannot silently fall back', () => {
  const { native } = fixture();
  assert.throws(() => createNativeCredentialPort({ secureStore: {} }), {
    code: 'INVALID_NATIVE_ADAPTER',
  });
  assert.throws(() => createNativeCredentialPort({
    secureStore: { ...native, deleteItemAsync: null },
  }), { code: 'INVALID_NATIVE_ADAPTER' });
  assert.throws(() => createNativeCredentialPort({
    secureStore: { ...native, WHEN_UNLOCKED_THIS_DEVICE_ONLY: undefined },
  }), { code: 'INVALID_NATIVE_ADAPTER' });
});

test('Android uses native Keystore without requiring an iOS-only Keychain constant', async () => {
  const { native, calls } = fixture();
  delete native.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
  const port = createNativeCredentialPort({ secureStore: native, platform: 'android' });
  await port.writeToken('android-fixture-token');
  assert.equal(await port.readToken(), 'android-fixture-token');
  await port.clearToken();
  assert.equal(await port.readToken(), null);
  const operations = calls.filter(event => event[0] !== 'available');
  assert.ok(operations.every(event => !('keychainAccessible' in event[2])));
  assert.ok(operations.every(event => event[2].requireAuthentication === false));
  assert.throws(() => createNativeCredentialPort({ secureStore: native, platform: 'web' }), { code: 'INVALID_NATIVE_ADAPTER' });
});

test('rejects unsafe empty, whitespace, control, oversized or non-string tokens before native IO', async () => {
  const { native, calls } = fixture();
  const port = createNativeCredentialPort({ secureStore: native });
  for (const token of ['', ' bad', 'bad ', 'bad\nline', 'bad\u0000value', 'x'.repeat(8193), null, 1]) {
    await expectCode(port.writeToken(token), 'INVALID_TOKEN');
  }
  assert.deepEqual(calls, []);
});

test('invalid token returned by native store never becomes a successful session', async () => {
  const { native } = fixture();
  native.getItemAsync = async () => 'bad\nsession';
  const port = createNativeCredentialPort({ secureStore: native });
  await expectCode(port.readToken(), 'INVALID_STORED_TOKEN');
});

test('unavailable native store blocks reading, writing and clearing rather than using AsyncStorage', async () => {
  const { native, calls } = fixture();
  native.isAvailableAsync = async () => { calls.push(['unavailable']); return false; };
  const port = createNativeCredentialPort({ secureStore: native });
  await expectCode(port.readToken(), 'STORAGE_UNAVAILABLE');
  await expectCode(port.writeToken('token'), 'STORAGE_UNAVAILABLE');
  await expectCode(port.clearToken(), 'STORAGE_UNAVAILABLE');
  assert.deepEqual(calls.map((call) => call[0]), ['unavailable', 'unavailable', 'unavailable']);
});

test('native rejection is opaque and never claims a successful deletion', async () => {
  const { native } = fixture();
  native.setItemAsync = async () => { throw new Error('native-secret-1'); };
  native.getItemAsync = async () => { throw new Error('native-secret-2'); };
  native.deleteItemAsync = async () => { throw new Error('native-secret-3'); };
  const port = createNativeCredentialPort({ secureStore: native });
  await expectCode(port.writeToken('not-logged'), 'STORAGE_FAILURE');
  await expectCode(port.readToken(), 'STORAGE_FAILURE');
  await expectCode(port.clearToken(), 'STORAGE_FAILURE');
});

test('availability errors fail closed with a generic error', async () => {
  const { native } = fixture();
  native.isAvailableAsync = async () => { throw new Error('secret device status'); };
  const port = createNativeCredentialPort({ secureStore: native });
  await expectCode(port.readToken(), 'STORAGE_UNAVAILABLE');
});

test('later logout deletion cannot finish before an earlier in-flight write', async () => {
  const { native, calls, getSecret } = fixture();
  let releaseWrite;
  const waiting = new Promise((resolve) => { releaseWrite = resolve; });
  native.setItemAsync = async (key, value, options) => {
    calls.push(['set-start', key, options]);
    await waiting;
    // Mimics native storage finishing the first write after a delayed callback.
    native.__commit(value);
  };
  let storage = null;
  native.__commit = (value) => { storage = value; };
  native.deleteItemAsync = async (key, options) => {
    calls.push(['delete', key, options]);
    storage = null;
  };
  const port = createNativeCredentialPort({ secureStore: native });
  const write = port.writeToken('session-to-clear');
  const clear = port.clearToken();
  // The serializer must not allow delete while the first native write is pending.
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(!calls.some((c) => c[0] === 'delete'));
  releaseWrite();
  await Promise.all([write, clear]);
  assert.equal(storage, null);
  assert.deepEqual(calls.filter((c) => ['set-start', 'delete'].includes(c[0]))
    .map((c) => c[0]), ['set-start', 'delete']);
  assert.equal(getSecret(), null);
});

test('a failed operation does not permanently wedge the operation queue', async () => {
  const { native } = fixture();
  let failNext = true;
  native.setItemAsync = async () => {
    if (failNext) {
      failNext = false;
      throw new Error('native write failed');
    }
  };
  const port = createNativeCredentialPort({ secureStore: native });
  await expectCode(port.writeToken('first'), 'STORAGE_FAILURE');
  await port.writeToken('second');
  await port.clearToken();
});
