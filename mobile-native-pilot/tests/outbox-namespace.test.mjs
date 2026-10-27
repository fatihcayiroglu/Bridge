import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outboxNamespaceMaterial } from '../src/outbox-namespace.mjs';

test('native namespace material has no literal NUL and roundtrips account control characters', () => {
  const material = outboxNamespaceMaterial('https://bridge.test', 'A\u0000B');
  assert.equal(material.includes('\u0000'), false);
  assert.deepEqual(JSON.parse(material), ['bridge-native-outbox-v1', 'https://bridge.test', 'A\u0000B']);
});
test('distinct origins and accounts stay distinct across a NUL-terminated native string boundary', () => {
  const values = [
    outboxNamespaceMaterial('https://bridge.test', 'A'),
    outboxNamespaceMaterial('https://bridge.test', 'B'),
    outboxNamespaceMaterial('https://other.test', 'A'),
  ];
  assert.equal(new Set(values.map(value => value.split('\u0000')[0])).size, 3);
  assert.equal(values[0], outboxNamespaceMaterial('https://bridge.test', 'A'));
});
test('namespace refuses credentials, paths, noncanonical origins and invalid account identities', () => {
  for (const origin of ['http://bridge.test', 'https://a:b@bridge.test', 'https://bridge.test/', 'https://bridge.test/path', 'https://bridge.test#fragment']) {
    assert.throws(() => outboxNamespaceMaterial(origin, 'A'));
  }
  for (const account of ['', null, 123, 'x'.repeat(201)]) assert.throws(() => outboxNamespaceMaterial('https://bridge.test', account), /ACCOUNT_REQUIRED/);
});
