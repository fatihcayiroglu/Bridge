// server/tests/auth-insecure-defaults.test.ts
// Sprint 106: auth middleware insecure secret uyarıları testleri
// _validateSecret fonksiyonunun dev/test/prod davranışını doğrular

process.env.NODE_ENV = 'test';

describe('_validateSecret — Insecure Default Detection (Sprint 106)', () => {
  const INSECURE_DEFAULTS = [
    'bridge-dev-secret-CHANGE-IN-PRODUCTION',
    'bridge-refresh-secret-CHANGE-IN-PRODUCTION',
    'CHANGE_ME_LONG_RANDOM_STRING',
    'CHANGE_ME_DIFFERENT_LONG_STRING',
    'secret',
    'changeme',
  ];

  const SECURE_SECRET = 'a'.repeat(64); // 64 char güvenli secret

  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy:  jest.SpyInstance;
  let exitSpy:         jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy         = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Production: insecure default → process.exit(1) ────────────

  describe('production ortamı', () => {
    const originalEnv = process.env.NODE_ENV;

    beforeAll(() => { process.env.NODE_ENV = 'production'; });
    afterAll(() => { process.env.NODE_ENV = originalEnv; });

    it.each(INSECURE_DEFAULTS)('"%s" → production\'da process.exit çağrılır', (insecureVal) => {
      // Modül önbelleğini temizle — yeni env ile yeniden yükle
      jest.resetModules();
      process.env.JWT_SECRET     = insecureVal;
      process.env.REFRESH_SECRET = SECURE_SECRET;

      expect(() => {
        require('../middleware/auth');
      }).toThrow(); // exit mock'u throw atıyor

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('güvenli secret → process.exit çağrılmaz', () => {
      jest.resetModules();
      process.env.JWT_SECRET     = SECURE_SECRET;
      process.env.REFRESH_SECRET = SECURE_SECRET;

      expect(() => {
        require('../middleware/auth');
      }).not.toThrow();

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ── Test ortamı: insecure default → hata fırlatmaz, uyarı verir

  describe('test ortamı (mevcut)', () => {
    it.each(INSECURE_DEFAULTS)('"%s" → test\'te process.exit çağrılmaz', (insecureVal) => {
      jest.resetModules();
      process.env.NODE_ENV       = 'test';
      process.env.JWT_SECRET     = insecureVal;
      process.env.REFRESH_SECRET = SECURE_SECRET;

      // Test ortamında exit çağrılmamalı
      expect(() => {
        require('../middleware/auth');
      }).not.toThrow();

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ── Eksik secret ─────────────────────────────────────────────

  describe('eksik secret', () => {
    it('JWT_SECRET yok + production → process.exit(1)', () => {
      jest.resetModules();
      const saved = process.env.JWT_SECRET;
      process.env.NODE_ENV       = 'production';
      process.env.JWT_SECRET     = '';
      process.env.REFRESH_SECRET = SECURE_SECRET;

      expect(() => {
        require('../middleware/auth');
      }).toThrow();

      expect(exitSpy).toHaveBeenCalledWith(1);

      process.env.JWT_SECRET = saved;
      process.env.NODE_ENV   = 'test';
    });

    it('JWT_SECRET yok + test → hata fırlatır (throw, exit değil)', () => {
      jest.resetModules();
      const saved = process.env.JWT_SECRET;
      process.env.NODE_ENV   = 'test';
      process.env.JWT_SECRET = '';

      expect(() => {
        require('../middleware/auth');
      }).toThrow(/JWT_SECRET/);

      process.env.JWT_SECRET = saved;
    });
  });

  // ── Çok kısa secret ───────────────────────────────────────────

  describe('kısa secret (< 32 karakter)', () => {
    it('31 karakter → production\'da process.exit(1)', () => {
      jest.resetModules();
      process.env.NODE_ENV       = 'production';
      process.env.JWT_SECRET     = 'a'.repeat(31);
      process.env.REFRESH_SECRET = SECURE_SECRET;

      expect(() => {
        require('../middleware/auth');
      }).toThrow();

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('32 karakter → geçerli', () => {
      jest.resetModules();
      process.env.NODE_ENV       = 'production';
      process.env.JWT_SECRET     = 'a'.repeat(32);
      process.env.REFRESH_SECRET = 'b'.repeat(32);

      expect(() => {
        require('../middleware/auth');
      }).not.toThrow();

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ── Sprint 106: dev banner ─────────────────────────────────────
  // CI=true ortamında gecikme atlanır; banner console.error'a yazılır

  describe('dev banner (Sprint 106)', () => {
    it('CI=true ile insecure secret → banner yazılır ama askıya alınmaz', () => {
      jest.resetModules();
      process.env.NODE_ENV   = 'development';
      process.env.CI         = 'true';
      process.env.JWT_SECRET = INSECURE_DEFAULTS[0];
      process.env.REFRESH_SECRET = SECURE_SECRET;

      const start = Date.now();
      expect(() => {
        require('../middleware/auth');
      }).not.toThrow();

      // CI=true → gecikme yok (< 500ms)
      expect(Date.now() - start).toBeLessThan(500);
      // Banner console.error'a yazıldı
      expect(consoleErrorSpy).toHaveBeenCalled();

      delete process.env.CI;
      process.env.NODE_ENV = 'test';
    });
  });
});
