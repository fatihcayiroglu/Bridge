import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decryptLocalJson } from '../../client/js/core/local-first/crypto.ts';

assert(process.env.LOCAL_CRYPTO_VECTOR_PATH, 'Native vector artifact is mandatory');
const envelope = JSON.parse(fs.readFileSync(process.env.LOCAL_CRYPTO_VECTOR_PATH, 'utf8'));
const key = await crypto.subtle.importKey('raw', Uint8Array.from({ length: 32 }, (_, i) => i), 'AES-GCM', false, ['decrypt']);
assert.deepEqual(await decryptLocalJson(key, envelope, 'user:interop:draft:channel%3Aserver%3Achannel'),
  { v: 1, text: 'shared envelope' });
console.log('PASS CryptoKit envelope decrypts with the production WebCrypto implementation');
