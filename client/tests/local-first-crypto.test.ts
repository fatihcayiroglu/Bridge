import { describe, expect, it } from 'vitest';
import {
  LOCAL_FIRST_MAX_CIPHERTEXT_BYTES,
  decryptLocalBytes,
  decryptLocalJson,
  encryptLocalBytes,
  encryptLocalJson,
  generateLocalFirstKey,
  type LocalFirstEnvelope,
} from '../js/core/local-first/crypto.ts';

describe('P7 local-first crypto envelope', () => {
  it('round-trips JSON without storing the plaintext in the envelope', async () => {
    const key = await generateLocalFirstKey();
    const scope = 'user:u1:draft:channel:c1';
    const value = { text: 'çok gizli taslak', savedAt: 123 };

    const envelope = await encryptLocalJson(key, value, scope);

    expect(JSON.stringify(envelope)).not.toContain(value.text);
    await expect(decryptLocalJson<typeof value>(key, envelope, scope)).resolves.toEqual(value);
  });

  it('binds ciphertext to its logical account/record scope', async () => {
    const key = await generateLocalFirstKey();
    const envelope = await encryptLocalBytes(
      key,
      new TextEncoder().encode('queued message'),
      'user:u1:outbox:a1',
    );

    await expect(
      decryptLocalBytes(key, envelope, 'user:u2:outbox:a1'),
    ).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const key = await generateLocalFirstKey();
    const scope = 'user:u1:history:c1:m1';
    const envelope = await encryptLocalJson(key, { content: 'hello' }, scope);
    const replacement = envelope.ct[0] === 'A' ? 'B' : 'A';
    const tampered: LocalFirstEnvelope = { ...envelope, ct: replacement + envelope.ct.slice(1) };

    await expect(decryptLocalJson(key, tampered, scope)).rejects.toThrow();
  });

  it('generates a non-extractable data key', async () => {
    const key = await generateLocalFirstKey();

    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('rejects malformed envelopes before decrypting', async () => {
    const key = await generateLocalFirstKey();

    await expect(
      decryptLocalJson(key, { v: 99, alg: 'AES-GCM', iv: 'AAAA', ct: 'AAAA' }, 'user:u1:x'),
    ).rejects.toThrow('Invalid local-first envelope');
    await expect(decryptLocalJson(key, null, 'user:u1:x')).rejects.toThrow('Invalid local-first envelope');
    await expect(decryptLocalJson(key, [], 'user:u1:x')).rejects.toThrow('Invalid local-first envelope');
    await expect(
      decryptLocalJson(key, { v: 1, alg: 'AES-GCM', iv: 123, ct: 'AAAA' }, 'user:u1:x'),
    ).rejects.toThrow('Invalid local-first envelope');
  });

  it('rejects invalid base64, IV length and invalid scope before WebCrypto decrypt', async () => {
    const key = await generateLocalFirstKey();
    const scope = 'user:u1:x';
    const valid = await encryptLocalJson(key, { ok: true }, scope);

    await expect(
      decryptLocalBytes(key, { ...valid, iv: '***=' }, scope),
    ).rejects.toThrow('Invalid local-first base64');
    await expect(
      decryptLocalBytes(key, { ...valid, iv: 'AAAA' }, scope),
    ).rejects.toThrow('Invalid local-first IV');
    await expect(
      decryptLocalBytes(key, { ...valid, ct: 'A' }, scope),
    ).rejects.toThrow('Invalid local-first base64');
    await expect(decryptLocalBytes(key, valid, '')).rejects.toThrow('Local-first scope is required');
    await expect(decryptLocalBytes(key, valid, 'x'.repeat(2048))).rejects.toThrow('Local-first scope is too large');
  });

  it('rejects non-byte and oversized plaintext inputs', async () => {
    const key = await generateLocalFirstKey();

    await expect(
      encryptLocalBytes(key, new Uint8ClampedArray([1, 2]) as unknown as Uint8Array, 'user:u1:x'),
    ).rejects.toThrow('Local-first plaintext must be bytes');

    const oversized = new Uint8Array(LOCAL_FIRST_MAX_CIPHERTEXT_BYTES + 1);
    await expect(encryptLocalBytes(key, oversized, 'user:u1:x'))
      .rejects.toThrow('Local-first plaintext is too large');
  });

  it('rejects malformed JSON after authenticated decryption', async () => {
    const key = await generateLocalFirstKey();
    const scope = 'user:u1:bad-json';
    const envelope = await encryptLocalBytes(key, new TextEncoder().encode('{not json'), scope);

    await expect(decryptLocalJson(key, envelope, scope)).rejects.toThrow();
  });
});
