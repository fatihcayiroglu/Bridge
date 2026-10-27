import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBridgeResultPrivacy } from './bridge-result-log-privacy.mjs';

test('accepts metadata-only logs with a real decrypt positive control', () => {
  assert.deepEqual(checkBridgeResultPrivacy([
    '⚡️  TO JS [payload redacted] CapacitorHttp request',
    'prefix ⚡️  TO JS [payload redacted] BridgeLocalFirstCrypto decrypt',
  ].join('\n')), { results: 2, decrypts: 1 });
});

test('rejects plaintext and arbitrary payloads without reflecting the secret', () => {
  for (const line of [
    '⚡️  TO JS {"plaintext":"PRIVATE_HISTORY_SENTINEL"}',
    '⚡️  TO JS [payload redacted] BridgeLocalFirstCrypto decrypt PRIVATE_HISTORY_SENTINEL',
  ]) {
    assert.throws(() => checkBridgeResultPrivacy(line), error =>
      error.message === 'IOS_NATIVE_RESULT_PAYLOAD_LOGGED' && !String(error).includes('PRIVATE_HISTORY_SENTINEL'));
  }
});

test('does not accept empty logs or ordinary plugin results without decrypting', () => {
  for (const text of ['', '⚡️  TO JS [payload redacted] CapacitorHttp request']) {
    assert.throws(() => checkBridgeResultPrivacy(text), /IOS_NATIVE_DECRYPT_LOG_CONTROL_MISSING/);
  }
});
