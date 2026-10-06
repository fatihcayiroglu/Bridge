import { describe, expect, it } from 'vitest';
import {
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
  });
});
