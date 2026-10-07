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


describe('P7 local-first crypto boundary coverage', () => {
  it('rejects non-byte and oversized plaintext before WebCrypto', async () => {
    const key = await generateLocalFirstKey();
    await expect(encryptLocalBytes(
      key,
      'not-bytes' as unknown as Uint8Array,
      'user:u1:test',
    )).rejects.toThrow('plaintext must be bytes');

    await expect(encryptLocalBytes(
      key,
      new Uint8Array(LOCAL_FIRST_MAX_CIPHERTEXT_BYTES + 1),
      'user:u1:test',
    )).rejects.toThrow('plaintext is too large');
  });

  it('rejects empty/oversized AAD scope and malformed base64/IV shapes', async () => {
    const key = await generateLocalFirstKey();
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(encryptLocalBytes(key, bytes, '')).rejects.toThrow('scope is required');
    await expect(encryptLocalBytes(key, bytes, 'x'.repeat(2_000))).rejects.toThrow('scope is too large');

    const malformed: unknown[] = [
      null,
      [],
      { v: 1, alg: 'AES-GCM', iv: '', ct: 'AAAA' },
      { v: 1, alg: 'AES-GCM', iv: '***=', ct: 'AAAA' },
      { v: 1, alg: 'AES-GCM', iv: 'AAAA', ct: 'AAAA' },
      { v: 2, alg: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' },
      { v: 1, alg: 'OTHER', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' },
    ];

    await expect(decryptLocalBytes(key, malformed[0], 'scope')).rejects.toThrow('Invalid local-first envelope');
    await expect(decryptLocalBytes(key, malformed[1], 'scope')).rejects.toThrow('Invalid local-first envelope');
    await expect(decryptLocalBytes(key, malformed[2], 'scope')).rejects.toThrow('Invalid local-first base64');
    await expect(decryptLocalBytes(key, malformed[3], 'scope')).rejects.toThrow('Invalid local-first base64');
    await expect(decryptLocalBytes(key, malformed[4], 'scope')).rejects.toThrow('Invalid local-first IV');
    await expect(decryptLocalBytes(key, malformed[5], 'scope')).rejects.toThrow('Invalid local-first envelope');
    await expect(decryptLocalBytes(key, malformed[6], 'scope')).rejects.toThrow('Invalid local-first envelope');
  });

  it('round-trips a payload larger than the base64 chunk boundary', async () => {
    const key = await generateLocalFirstKey();
    const bytes = new Uint8Array(0x8001);
    bytes[0] = 7;
    bytes[bytes.length - 1] = 9;

    const envelope = await encryptLocalBytes(key, bytes, 'user:u1:chunked');
    const decoded = await decryptLocalBytes(key, envelope, 'user:u1:chunked');
    expect(decoded.byteLength).toBe(bytes.byteLength);
    expect(decoded[0]).toBe(7);
    expect(decoded.at(-1)).toBe(9);
  });
});

describe('P7 local-first crypto resource and environment bounds', () => {
  it('an oversized stored ciphertext is refused before any decryption work', async () => {
    const key = await generateLocalFirstKey();
    const envelope = await encryptLocalJson(key, { ok: true }, 'user:u1:big');
    // Valid base64 that decodes past the bound (a hostile or corrupted record).
    const huge = 'A'.repeat(Math.ceil(((LOCAL_FIRST_MAX_CIPHERTEXT_BYTES + 3) / 3)) * 4);
    await expect(decryptLocalJson(key, { ...envelope, ct: huge } as LocalFirstEnvelope, 'user:u1:big'))
      .rejects.toThrow('ciphertext is too large');
  });

  it('fails closed with a clear error when Web Crypto is unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    try {
      await expect(generateLocalFirstKey()).rejects.toThrow('Web Crypto is unavailable');
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});
