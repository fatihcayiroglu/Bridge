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

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};


/**
 * These deployment branches were previously invisible to the ordinary
 * round-trip tests because the module caches its first resolved encryption
 * key. Each case therefore loads a FRESH module registry with controlled
 * deployment environment and restores the caller's environment afterwards.
 * Never invoke the real process.exit in a Jest worker.
 */
describe('apKeyEncryption — production key safety and fallback branches', () => {
  const keys = ['AP_ENCRYPTION_KEY', 'FEDERATION_ENABLED', 'NODE_ENV'] as const;
  type Environment = Partial<Record<typeof keys[number], string | undefined>>;
  type Encryption = typeof import('../lib/apKeyEncryption');
  type Audit = import('../lib/logger').BridgeLogger;

  function withFreshModule(input: Environment, check: (api: Encryption, audit: Audit) => void): void {
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])) as Environment;
    try {
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      let api!: Encryption;
      let audit!: Audit;
      jest.isolateModules(() => {
        api = require('../lib/apKeyEncryption') as Encryption;
        audit = require('../lib/logger').default as Audit;
      });
      check(api, audit);
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('explicitly warns and falls back only in nonproduction when federation requires a missing key', () => {
    withFreshModule({
      AP_ENCRYPTION_KEY: undefined, FEDERATION_ENABLED: 'true', NODE_ENV: 'test',
    }, (api, audit) => {
      const warning = jest.spyOn(audit, 'warn').mockImplementation(() => undefined);
      const fatal = jest.spyOn(audit, 'fatal').mockImplementation(() => undefined);
      try {
        const encrypted = api.encryptApPrivateKey('real-private-key-canary');
        expect(api.decryptApPrivateKey(encrypted)).toBe('real-private-key-canary');
        expect(warning).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'ap_key.missing' }), expect.any(String),
        );
        expect(warning).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'ap_key.fallback' }), expect.any(String),
        );
        expect(fatal).not.toHaveBeenCalled();
        // _loadKey is cached inside one process: a second call does not
        // repeatedly silently generate a new ephemeral key.
        api.encryptApPrivateKey('second');
        expect(warning).toHaveBeenCalledTimes(2);
      } finally {
        warning.mockRestore();
        fatal.mockRestore();
      }
    });
  });

  it('logs only the fallback event when federation is disabled and no key is configured', () => {
    withFreshModule({
      AP_ENCRYPTION_KEY: undefined, FEDERATION_ENABLED: 'false', NODE_ENV: 'production',
    }, (api, audit) => {
      const warning = jest.spyOn(audit, 'warn').mockImplementation(() => undefined);
      const fatal = jest.spyOn(audit, 'fatal').mockImplementation(() => undefined);
      try {
        const data = api.encryptApPrivateKey('federation-off');
        expect(api.canDecrypt(data)).toBe(true);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'ap_key.fallback' }), expect.any(String),
        );
        expect(fatal).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        fatal.mockRestore();
      }
    });
  });

  it('rejects invalid-length and nonhex configured keys in development without echoing secret bytes', () => {
    for (const bad of ['z'.repeat(64), 'e'.repeat(63), 'e'.repeat(65)]) {
      withFreshModule({
        AP_ENCRYPTION_KEY: bad, FEDERATION_ENABLED: 'true', NODE_ENV: 'test',
      }, (api, audit) => {
        const warning = jest.spyOn(audit, 'warn').mockImplementation(() => undefined);
        const fatal = jest.spyOn(audit, 'fatal').mockImplementation(() => undefined);
        try {
          expect(() => api.encryptApPrivateKey('secret')).toThrow(/64-char hex string/);
          try {
            api.encryptApPrivateKey('secret');
            throw new Error('unexpected successful encryption');
          } catch (err) {
            expect(String(err)).not.toContain(bad);
          }
          expect(warning).not.toHaveBeenCalled();
          expect(fatal).not.toHaveBeenCalled();
        } finally {
          warning.mockRestore();
          fatal.mockRestore();
        }
      });
    }
  });

  it('refuses a missing production federation key with a fatal event and exit(1)', () => {
    withFreshModule({
      AP_ENCRYPTION_KEY: undefined, FEDERATION_ENABLED: 'true', NODE_ENV: 'production',
    }, (api, audit) => {
      const warning = jest.spyOn(audit, 'warn').mockImplementation(() => undefined);
      const fatal = jest.spyOn(audit, 'fatal').mockImplementation(() => undefined);
      const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('test-intercepted-production-exit');
      });
      try {
        expect(() => api.encryptApPrivateKey('never-encrypt')).toThrow('test-intercepted-production-exit');
        expect(exit).toHaveBeenCalledWith(1);
        expect(fatal).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'ap_key.missing' }), expect.any(String),
        );
        expect(warning).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        warning.mockRestore();
        fatal.mockRestore();
      }
    });
  });

  it('refuses an invalid production key with a fatal event and exit(1)', () => {
    withFreshModule({
      AP_ENCRYPTION_KEY: 'not-a-32-byte-hex-key',
      FEDERATION_ENABLED: 'true', NODE_ENV: 'production',
    }, (api, audit) => {
      const fatal = jest.spyOn(audit, 'fatal').mockImplementation(() => undefined);
      const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('test-intercepted-production-exit');
      });
      try {
        expect(() => api.encryptApPrivateKey('never-encrypt')).toThrow('test-intercepted-production-exit');
        expect(exit).toHaveBeenCalledWith(1);
        expect(fatal).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'ap_key.invalid' }), expect.any(String),
        );
        const message = fatal.mock.calls[0]?.[1];
        expect(message).not.toContain('not-a-32-byte-hex-key');
      } finally {
        exit.mockRestore();
        fatal.mockRestore();
      }
    });
  });

  it('fails authentication for modified IV and rejects a 28-byte blob with an invalid GCM tag', () => {
    withFreshModule({
      AP_ENCRYPTION_KEY: 'c'.repeat(64), FEDERATION_ENABLED: 'true', NODE_ENV: 'test',
    }, (api, audit) => {
      const warning = jest.spyOn(audit, 'warn').mockImplementation(() => undefined);
      try {
        const encrypted = Buffer.from(api.encryptApPrivateKey('federation-secret'), 'base64');
        encrypted[0] ^= 0x01; // IV is authenticated by the tag, not just ciphertext.
        expect(api.decryptApPrivateKey(encrypted.toString('base64'))).toBeNull();
        expect(api.decryptApPrivateKey(Buffer.alloc(28).toString('base64'))).toBeNull();
        expect(warning).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'ap_key.decrypt.failed' }), expect.any(String),
        );
      } finally {
        warning.mockRestore();
      }
    });
  });
});
