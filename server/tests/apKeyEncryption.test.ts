// server/tests/apKeyEncryption.test.ts
// AES-256-GCM şifreleme/çözme utility testleri

'use strict';

// AP_ENCRYPTION_KEY'i test için set et
process.env.AP_ENCRYPTION_KEY = 'a'.repeat(64); // 64 hex = 32 byte

const {
  encryptApPrivateKey,
  decryptApPrivateKey,
  canDecrypt,
} = require('../lib/apKeyEncryption');

describe('apKeyEncryption', () => {
  const SAMPLE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLzHPZe5RJr9MrLMFpKFHxsWvqTWGmAlMmNgdANp
...test key content...
-----END RSA PRIVATE KEY-----`;

  describe('encryptApPrivateKey', () => {
    it('returns a base64 string', () => {
      const enc = encryptApPrivateKey(SAMPLE_KEY);
      expect(typeof enc).toBe('string');
      // base64 karakter seti kontrolü
      expect(enc).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('produces different output each call (random IV)', () => {
      const enc1 = encryptApPrivateKey(SAMPLE_KEY);
      const enc2 = encryptApPrivateKey(SAMPLE_KEY);
      expect(enc1).not.toBe(enc2);
    });

    it('produces output longer than plaintext (IV + authTag overhead)', () => {
      const enc = encryptApPrivateKey(SAMPLE_KEY);
      const decoded = Buffer.from(enc, 'base64');
      // IV (12) + authTag (16) + ciphertext (≥1)
      expect(decoded.length).toBeGreaterThan(28);
    });
  });

  describe('decryptApPrivateKey', () => {
    it('round-trips correctly', () => {
      const enc = encryptApPrivateKey(SAMPLE_KEY);
      const dec = decryptApPrivateKey(enc);
      expect(dec).toBe(SAMPLE_KEY);
    });

    it('returns null for corrupted data', () => {
      const result = decryptApPrivateKey('bm90YmFzZTY0dGhpcw==');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = decryptApPrivateKey('');
      expect(result).toBeNull();
    });

    it('returns null when auth tag is tampered', () => {
      const enc = encryptApPrivateKey(SAMPLE_KEY);
      const buf = Buffer.from(enc, 'base64');
      // authTag bölgesini (byte 12-27) bozalım
      buf[15] ^= 0xff;
      const tampered = buf.toString('base64');
      const result = decryptApPrivateKey(tampered);
      expect(result).toBeNull();
    });

    it('returns null when ciphertext is tampered', () => {
      const enc = encryptApPrivateKey(SAMPLE_KEY);
      const buf = Buffer.from(enc, 'base64');
      // ciphertext bölgesini boz (byte 28+)
      if (buf.length > 30) buf[30] ^= 0xff;
      const tampered = buf.toString('base64');
      const result = decryptApPrivateKey(tampered);
      expect(result).toBeNull();
    });
  });

  describe('canDecrypt', () => {
    it('returns true for valid encrypted data', () => {
      const enc = encryptApPrivateKey(SAMPLE_KEY);
      expect(canDecrypt(enc)).toBe(true);
    });

    it('returns false for invalid data', () => {
      expect(canDecrypt('garbage')).toBe(false);
    });
  });

  describe('key validation', () => {
    it('encrypts and decrypts empty string', () => {
      const enc = encryptApPrivateKey('');
      expect(decryptApPrivateKey(enc)).toBe('');
    });

    it('handles unicode content', () => {
      const unicode = 'test-key-🔑-unicode-içerik';
      const enc = encryptApPrivateKey(unicode);
      expect(decryptApPrivateKey(enc)).toBe(unicode);
    });

    it('handles large keys (4096-bit RSA PEM ≈ 3.2KB)', () => {
      const largeKey = '-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(3200) + '\n-----END RSA PRIVATE KEY-----';
      const enc = encryptApPrivateKey(largeKey);
      expect(decryptApPrivateKey(enc)).toBe(largeKey);
    });
  });
});

describe('apKeyEncryption — wrong key', () => {
  it('returns null when decrypting with a different key', () => {
    // Farklı key ile şifrele
    const originalKey = process.env.AP_ENCRYPTION_KEY;
    process.env.AP_ENCRYPTION_KEY = 'b'.repeat(64);
    // Module cache'i temizle (key farklı olsun)
    jest.resetModules();
    const enc1 = require('../lib/apKeyEncryption').encryptApPrivateKey('test');

    // Orijinal key ile çözmeye çalış
    process.env.AP_ENCRYPTION_KEY = originalKey;
    jest.resetModules();
    const result = require('../lib/apKeyEncryption').decryptApPrivateKey(enc1);
    expect(result).toBeNull();

    // Temizlik
    process.env.AP_ENCRYPTION_KEY = originalKey;
    jest.resetModules();
  });
});
