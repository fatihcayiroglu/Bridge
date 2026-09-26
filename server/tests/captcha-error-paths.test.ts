// server/tests/captcha-error-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/captcha.ts — HATA VE RET DALLARI
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR: `lib/captcha.ts` güvenlik katmanında EN DÜŞÜK dal
// kapsamına sahip modüldü — %44.6 dal, 107 kapsanmayan dal, hiç özel testi
// yoktu. Modül şunları yönetir:
//
//   · giriş kilidi (kaba kuvvet)          · kayıt kotası (hesap fabrikası)
//   · CAPTCHA replay koruması             · bot puanlaması
//   · şüpheli giriş tespiti               · fail-closed güvenlik middleware'i
//
// Bu dalların çoğu HATA yollarıdır ve tam olarak orada bir kusur zaten
// bulunmuştu (2026-08-28: bir `.catch()` gövdesinde import edilmemiş `logger`
// süreç düşürebiliyordu). Mutlu yolu test etmek bu sınıfı yakalamaz.
//
// ── İZOLASYON TEKNİĞİ ──────────────────────────────────────────────────────
// `isEnabled` ve `CFG` MODÜL YÜKLENİRKEN okunur, bu yüzden farklı
// yapılandırmaları ölçmenin tek yolu modül kaydını izole etmektir.
// `loadCaptcha()` istenen ortamla taze bir kopya döndürür.

process.env.NODE_ENV = 'test';

import type { Request, Response, NextFunction } from 'express';

// ── Dış sınırlar ───────────────────────────────────────────────────────────
const mockFetchT = jest.fn();
jest.mock('../lib/fetch', () => ({ fetchT: (...a: unknown[]) => mockFetchT(...a) }));

const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  setIfAbsentAuthoritative: jest.fn(),
  getAuthoritative: jest.fn(),
  setAuthoritative: jest.fn(),
  del: jest.fn(),
  delAuthoritative: jest.fn(),
};
jest.mock('../lib/redisAdapter', () => ({
  cache: mockCache,
  isRedisAvailable: jest.fn(() => false),
}));

const mockSendAlert = jest.fn();
jest.mock('../lib/mailer', () => ({ sendSuspiciousLoginAlert: (...a: unknown[]) => mockSendAlert(...a) }));

type CaptchaModule = typeof import('../lib/captcha');

/** Verilen ortamla `lib/captcha` modülünü TAZE yükler. */
function loadCaptcha(env: Record<string, string | undefined> = {}): CaptchaModule {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let mod!: CaptchaModule;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../lib/captcha');
    });
  } finally {
    // Invalid env tests may throw during module initialization. Restoring in a
    // finally block keeps that deliberate failure from poisoning later cases.
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return mod;
}

function req(headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Request {
  return { headers, method: 'GET', socket: { remoteAddress: '203.0.113.9' }, ...extra } as unknown as Request;
}

function res() {
  const r: Record<string, unknown> = {};
  r.statusCode = 0;
  r.body = undefined;
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; return r; });
  return r as unknown as Response & { statusCode: number; body: Record<string, unknown> };
}

const mockValues = new Map<string, unknown>();

beforeEach(() => {
  mockValues.clear();
  mockFetchT.mockReset();
  mockSendAlert.mockReset();
  for (const fn of Object.values(mockCache)) fn.mockReset();
  // Model the redisAdapter cache contract instead of a write-dropping stub.
  // Security counter tests need later reads to observe earlier writes.
  mockCache.get.mockImplementation(async (key: string) => mockValues.get(key) ?? null);
  mockCache.getAuthoritative.mockImplementation(async (key: string) => mockValues.get(key) ?? null);
  mockCache.set.mockImplementation(async (key: string, value: unknown) => { mockValues.set(key, value); });
  mockCache.setAuthoritative.mockImplementation(async (key: string, value: unknown) => { mockValues.set(key, value); });
  mockCache.del.mockImplementation(async (key: string) => { mockValues.delete(key); });
  mockCache.delAuthoritative.mockImplementation(async (key: string) => { mockValues.delete(key); });
  mockCache.setIfAbsentAuthoritative.mockImplementation(async (key: string, value: unknown) => {
    if (mockValues.has(key)) return false;
    mockValues.set(key, value);
    return true;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// verifyCaptcha — sağlayıcı ve replay hataları
// ════════════════════════════════════════════════════════════════════════════
describe('verifyCaptcha — hata dalları', () => {
  const ENABLED = { CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined };

  it('CAPTCHA kapalıyken doğrulama ATLANIR', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false', TURNSTILE_SECRET: undefined, HCAPTCHA_SECRET: undefined });
    await expect(c.verifyCaptcha('t', '1.2.3.4')).resolves.toEqual({ ok: true, skip: true });
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('sağlayıcı yapılandırılmamışsa doğrulama ATLANIR (provider=none)', async () => {
    // `enabled` true olsa bile secret yoksa provider 'none' olur.
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: undefined, HCAPTCHA_SECRET: undefined });
    await expect(c.verifyCaptcha('t', '1.2.3.4')).resolves.toEqual({ ok: true, skip: true });
  });

  it('token YOKSA reddeder', async () => {
    const c = loadCaptcha(ENABLED);
    const r = await c.verifyCaptcha('', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/eksik/i);
  });

  it('replay deposu OKUNAMAZSA fail-closed reddeder', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // Depo belirsizse "geçerli say" demek, replay korumasını tamamen
    // devre dışı bırakırdı. Belirsizlik ERİŞİM VERMEMELİ.
    const c = loadCaptcha(ENABLED);
    mockCache.getAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    const r = await c.verifyCaptcha('token-1', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/güvenlik deposu/i);
    expect(mockFetchT).not.toHaveBeenCalled();   // sağlayıcıya hiç gidilmez
  });

  it('token ZATEN KULLANILMIŞSA reddeder (replay)', async () => {
    const c = loadCaptcha(ENABLED);
    mockCache.getAuthoritative.mockResolvedValueOnce(1); // paylaşılan depoda işaretli
    const r = await c.verifyCaptcha('token-2', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/süresi doldu/i);
  });

  it('sağlayıcı HTTP hatası verirse reddeder', async () => {
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const r = await c.verifyCaptcha('token-3', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ulaşılamadı/i);
  });

  it('sağlayıcı BAŞARILI dese bile token talebi KAYBEDİLİRSE reddeder', async () => {
    // Yarış kaybedeni: iki node aynı CAPTCHA yanıtını aynı anda doğrularsa
    // yalnızca biri talebi kazanmalı; diğeri KABUL EDİLMEMELİ.
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(false);   // talebi kaybettik
    const r = await c.verifyCaptcha('token-4', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/süresi doldu/i);
  });

  it('sağlayıcı BAŞARILI olsa da replay talebi yazılamazsa geliştirmede bile fail-closed reddeder', async () => {
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    mockCache.setIfAbsentAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await expect(c.verifyCaptcha('token-claim-down', '1.2.3.4')).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/güvenlik deposu/i),
      });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('sağlayıcı BAŞARILI ve talep KAZANILIRSA kabul eder (yanlış pozitif kontrolü)', async () => {
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(true);
    await expect(c.verifyCaptcha('token-5', '1.2.3.4')).resolves.toEqual({ ok: true });
  });

  it.each([
    ['timeout-or-duplicate', /süresi doldu/i],
    ['invalid-input-response', /geçersiz captcha/i],
    ['some-other-code', /doğrulanamadı/i],
  ])('sağlayıcı hata kodu %s doğru mesaja eşlenir', async (code, expected) => {
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockResolvedValueOnce({
      ok: true, json: async () => ({ success: false, 'error-codes': [code] }),
    });
    const r = await c.verifyCaptcha('token-6', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(expected);
  });

  it('hata kodu HİÇ yoksa genel ret döner', async () => {
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ success: false }) });
    const r = await c.verifyCaptcha('token-7', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/doğrulanamadı/i);
  });

  it('ÜRETİMDE sağlayıcı istisnası fail-closed reddeder', async () => {
    // Bu, geliştirme kolaylığının üretime sızmadığının kanıtıdır.
    // DİKKAT: bu dalda `NODE_ENV` ÇAĞRI ANINDA okunur (modül yüklenirken
    // değil), bu yüzden ortam çağrının etrafında ayarlanır.
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockRejectedValueOnce(new Error('network unreachable'));
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await c.verifyCaptcha('token-8', '1.2.3.4');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/geçici olarak kullanılamıyor/i);
      expect(r.skip).toBeUndefined();
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('GELİŞTİRMEDE sağlayıcı istisnası atlanır (kasıtlı kolaylık)', async () => {
    const c = loadCaptcha(ENABLED);
    mockFetchT.mockRejectedValueOnce(new Error('network unreachable'));
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await expect(c.verifyCaptcha('token-9', '1.2.3.4')).resolves.toEqual({ ok: true, skip: true });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Giriş kilidi — kaba kuvvet koruması
// ════════════════════════════════════════════════════════════════════════════
describe('giriş kilidi', () => {
  const CFG = { MAX_FAILED_LOGINS: '3', LOGIN_LOCKOUT_MS: '60000' };

  it('eşiğin ALTINDA kilitlemez', async () => {
    const c = loadCaptcha(CFG);
    await c.recordFailedLogin('ip-a');
    await c.recordFailedLogin('ip-a');
    expect(await c.isLoginLocked('ip-a')).toBe(false);
    expect(await c.getFailCount('ip-a')).toBe(2);
  });

  it('eşiğe ULAŞINCA kilitler ve kalan süre bildirir', async () => {
    const c = loadCaptcha(CFG);
    for (let i = 0; i < 3; i++) await c.recordFailedLogin('ip-b');
    expect(await c.isLoginLocked('ip-b')).toBe(true);
    const remain = await c.loginLockRemainingMs('ip-b');
    expect(remain).toBeGreaterThan(0);
    expect(remain).toBeLessThanOrEqual(60_000);
  });

  it('kilit SÜRESİ DOLUNCA kendini temizler', async () => {
    const c = loadCaptcha({ ...CFG, LOGIN_LOCKOUT_MS: '1000' });
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    for (let i = 0; i < 3; i++) await c.recordFailedLogin('ip-c');
    now.mockReturnValue(start + 1001);
    expect(await c.isLoginLocked('ip-c')).toBe(false);
    // Sayaç da sıfırlanmalı: kullanıcı temiz bir sayfayla döner.
    expect(await c.getFailCount('ip-c')).toBe(0);
    now.mockRestore();
  });

  it('BAŞARILI giriş sayacı ve kilidi sıfırlar', async () => {
    const c = loadCaptcha(CFG);
    for (let i = 0; i < 3; i++) await c.recordFailedLogin('ip-d');
    await c.recordSuccessfulLogin('ip-d');
    expect(await c.isLoginLocked('ip-d')).toBe(false);
    expect(await c.getFailCount('ip-d')).toBe(0);
  });

  it('kilitlenmemiş IP için kalan süre 0', async () => {
    const c = loadCaptcha(CFG);
    expect(await c.loginLockRemainingMs('ip-fresh')).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Kayıt kotası — hesap fabrikası koruması
// ════════════════════════════════════════════════════════════════════════════
describe('kayıt kotası', () => {
  it('kota altında engellenmez, kotada engellenir', async () => {
    const c = loadCaptcha({ MAX_REG_PER_HOUR: '2' });
    await c.recordRegistration('reg-a');
    expect(await c.isRegistrationThrottled('reg-a')).toBe(false);
    await c.recordRegistration('reg-a');
    expect(await c.isRegistrationThrottled('reg-a')).toBe(true);
  });

  it('1 saatten ESKİ kayıtlar pencereden düşer', async () => {
    // Kayan pencere: eski kayıtlar sonsuza kadar ceza vermemeli.
    const c = loadCaptcha({ MAX_REG_PER_HOUR: '2' });
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    mockCache.get.mockResolvedValue({ fails: 0, lockedUntil: 0, regs: [twoHoursAgo, twoHoursAgo] });
    expect(await c.isRegistrationThrottled('reg-b')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bot puanı
// ════════════════════════════════════════════════════════════════════════════
describe('getBotScore', () => {
  const c = loadCaptcha();

  it('tam donanımlı tarayıcı isteği DÜŞÜK puan alır', () => {
    const score = c.getBotScore(req({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
      'accept-language': 'tr-TR', accept: 'text/html', 'accept-encoding': 'gzip',
      connection: 'keep-alive', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate',
    }));
    expect(score).toBeLessThan(60);
  });

  it('bilinen bot istemcileri YÜKSEK puan alır', () => {
    for (const ua of ['curl/8.4.0', 'python-requests/2.31', 'Go-http-client/1.1', 'okhttp/4.9']) {
      expect(c.getBotScore(req({ 'user-agent': ua }))).toBeGreaterThanOrEqual(60);
    }
  });

  it('user-agent YOKSA ağır ceza alır', () => {
    expect(c.getBotScore(req({}))).toBeGreaterThanOrEqual(40);
  });

  it('content-type olmayan POST ek puan alır', () => {
    const withCt = c.getBotScore(req({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120', 'content-type': 'application/json' }, { method: 'POST' }));
    const noCt = c.getBotScore(req({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120' }, { method: 'POST' }));
    expect(noCt).toBeGreaterThan(withCt);
  });

  it('kısa "mozilla" taklidi ek puan alır', () => {
    expect(c.getBotScore(req({ 'user-agent': 'Mozilla/5.0' }))).toBeGreaterThanOrEqual(20);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Middleware'ler — özellikle FAIL-CLOSED dalları
// ════════════════════════════════════════════════════════════════════════════
describe('güvenlik middleware fail-closed davranışı', () => {
  const next = (): NextFunction => jest.fn() as unknown as NextFunction;

  // ── NEDEN BURADA "503 fail-closed" TESTİ YOK ───────────────────────────
  // `failClosedSecurityMiddleware` bu üç middleware icin ULASILAMAZ savunma
  // kodudur: `_storeGet` / `_storeSet` paylasilan depo hatalarini YAKALAR ve
  // surec-ici bellege duser, dolayisiyla `isLoginLocked` /
  // `isRegistrationThrottled` pratikte reddetmez.
  //
  // Bu bir kusur DEGIL, bilincli bir kullanilabilirlik secimidir: fail-closed
  // davranmak bir Redis kesintisini TAM giris kesintisine cevirirdi. Ancak
  // GERCEK davranis (kume genelinden surec basina dusme) olculmelidir --
  // dosyanin sonundaki "bozulma" testleri tam olarak onu yapar.
  //
  // Kapsam kategorisi: C (gercekten ulasilamayan savunma kodu).

  it('loginLockMiddleware KİLİTLİ IP için 429 ve retryAfter döner', async () => {
    const c = loadCaptcha({ MAX_FAILED_LOGINS: '1', LOGIN_LOCKOUT_MS: '600000' });
    await c.recordFailedLogin('203.0.113.9');

    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.loginLockMiddleware(req(), r, n);
    await new Promise(setImmediate);

    expect(r.statusCode).toBe(429);
    expect((r.body as { locked: boolean }).locked).toBe(true);
    expect((r.body as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    expect(n).not.toHaveBeenCalled();
  });

  it('loginLockMiddleware kilitsiz IP için GEÇİRİR', async () => {
    const c = loadCaptcha();
    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.loginLockMiddleware(req(), r, n);
    await new Promise(setImmediate);
    expect(n).toHaveBeenCalled();
    expect(r.statusCode).toBe(0);
  });

  it('registrationThrottleMiddleware kota dolunca 429 döner', async () => {
    const c = loadCaptcha({ MAX_REG_PER_HOUR: '1' });
    await c.recordRegistration('203.0.113.9');

    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.registrationThrottleMiddleware(req(), r, n);
    await new Promise(setImmediate);

    expect(r.statusCode).toBe(429);
    expect(n).not.toHaveBeenCalled();
  });

  it('botFilterMiddleware eşiği aşan isteği 403 ile reddeder', () => {
    const c = loadCaptcha();
    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.botFilterMiddleware(60)(req({ 'user-agent': 'curl/8.4.0' }), r, n);
    expect(r.statusCode).toBe(403);
    expect(n).not.toHaveBeenCalled();
  });

  it('botFilterMiddleware normal tarayıcıyı GEÇİRİR', () => {
    const c = loadCaptcha();
    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.botFilterMiddleware(60)(req({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
      'accept-language': 'tr', accept: 'text/html', 'accept-encoding': 'gzip',
      connection: 'keep-alive', 'sec-fetch-site': 'same-origin',
    }), r, n);
    expect(n).toHaveBeenCalled();
    expect(r.statusCode).toBe(0);
  });

  it('captchaMiddleware kapalıyken GEÇİRİR', () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });
    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.captchaMiddleware(req({}, { body: {} }), r, n);
    expect(n).toHaveBeenCalled();
  });

  it('progressiveCaptchaMiddleware eşik altında CAPTCHA istemez', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's', PROGRESSIVE_CAPTCHA_THRESHOLD: '3' });
    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.progressiveCaptchaMiddleware(req({}, { body: {} }), r, n);
    await new Promise(setImmediate);
    expect(n).toHaveBeenCalled();
  });

  it('progressiveCaptchaMiddleware eşik üstünde token YOKSA 400 + requireCaptcha döner', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's', PROGRESSIVE_CAPTCHA_THRESHOLD: '1' });
    await c.recordFailedLogin('203.0.113.9');

    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.progressiveCaptchaMiddleware(req({}, { body: {} }), r, n);
    await new Promise(setImmediate);

    expect(r.statusCode).toBe(400);
    expect((r.body as { requireCaptcha: boolean }).requireCaptcha).toBe(true);
    expect(n).not.toHaveBeenCalled();
  });

});

// ════════════════════════════════════════════════════════════════════════════
// Şüpheli giriş — gizlilik ve tavsiye niteliğinde hata yolu
// ════════════════════════════════════════════════════════════════════════════
describe('checkSuspiciousLogin', () => {
  it('kullanıcı yoksa sessizce döner', async () => {
    const c = loadCaptcha();
    await expect(c.checkSuspiciousLogin(req(), null)).resolves.toBeUndefined();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('cihaz deposu ERİŞİLEMEZSE uyarı GÖNDERMEZ (spam yerine sessizlik)', async () => {
    // Belirsizlik hâlinde her girişte e-posta göndermek kullanıcıyı boğardı;
    // kimlik doğrulama da bundan ETKİLENMEMELİDİR.
    const c = loadCaptcha();
    mockCache.setIfAbsentAuthoritative.mockRejectedValueOnce(new Error('store down'));
    await expect(
      c.checkSuspiciousLogin(req(), { _id: 'u1', username: 'u', email: 'u@example.com' }),
    ).resolves.toBeUndefined();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('BİLİNEN cihazdan girişte uyarı gönderilmez', async () => {
    const c = loadCaptcha();
    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(false);   // anahtar zaten var → bilinen cihaz
    await c.checkSuspiciousLogin(req(), { _id: 'u1', username: 'u', email: 'u@example.com' });
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('YENİ cihazdan girişte uyarı gönderilir (yanlış pozitif kontrolü)', async () => {
    const c = loadCaptcha();
    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(true);    // ilk kez görülüyor
    await c.checkSuspiciousLogin(req(), { _id: 'u1', username: 'u', email: 'u@example.com' });
    expect(mockSendAlert).toHaveBeenCalled();
  });

  it('e-postası OLMAYAN kullanıcı için uyarı denenmez', async () => {
    const c = loadCaptcha();
    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(true);
    await c.checkSuspiciousLogin(req(), { _id: 'u1', username: 'u' });
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELIBERATE NO-REDIS MODE -- OPTIONAL CACHE BOZULMASI GOZLEMLENEBILIR
// ════════════════════════════════════════════════════════════════════════════
// REDIS_URL tanimli degilse single-node process-local CAPTCHA state bilincli
// olarak desteklenir. Optional cache helper hata verse bile bu moddaki
// koruma devam eder ve bozulma gozlemlenir. REDIS_URL configured durumda ise
// asagidaki ayri testte kanitlandigi gibi local quota'ya dusulmez, fail-closed
// 503 uygulanir.
describe('deliberate no-Redis optional cache degradation is observable', () => {
  it('depo hatasi bozulma durumunu KAYDEDER', async () => {
    const c = loadCaptcha();
    c._resetSharedStoreDegradationForTest();
    mockCache.get.mockRejectedValue(new Error('redis down'));

    await c.getFailCount('degraded-ip');

    const state = c._sharedStoreDegradationForTest();
    expect(state.degradedSince).not.toBeNull();
    expect(state.occurrences).toBeGreaterThan(0);
  });

  it('deliberate no-Redis modunda optional cache hatasina ragmen local kilit calisir', async () => {
    // Shared authority ilan edilmediginde bounded process-local state bu
    // deployment modunun kanonik sahibidir.
    const c = loadCaptcha({ MAX_FAILED_LOGINS: '2', LOGIN_LOCKOUT_MS: '60000' });
    c._resetSharedStoreDegradationForTest();
    mockCache.get.mockRejectedValue(new Error('redis down'));
    mockCache.set.mockRejectedValue(new Error('redis down'));

    await c.recordFailedLogin('mem-ip');
    await c.recordFailedLogin('mem-ip');

    expect(await c.isLoginLocked('mem-ip')).toBe(true);
  });

  it('depo TOPARLANINCA bozulma durumu temizlenir', async () => {
    const c = loadCaptcha();
    c._resetSharedStoreDegradationForTest();

    mockCache.get.mockRejectedValueOnce(new Error('redis down'));
    await c.getFailCount('recover-ip');
    expect(c._sharedStoreDegradationForTest().degradedSince).not.toBeNull();

    mockCache.get.mockResolvedValue(null);
  mockCache.getAuthoritative.mockResolvedValue(null);           // depo geri geldi
    await c.getFailCount('recover-ip');
    expect(c._sharedStoreDegradationForTest().degradedSince).toBeNull();
  });

  it('SAGLIKLI depoda bozulma kaydi OLUSMAZ (yanlis pozitif kontrolu)', async () => {
    const c = loadCaptcha();
    c._resetSharedStoreDegradationForTest();
    mockCache.get.mockResolvedValue(null);
  mockCache.getAuthoritative.mockResolvedValue(null);

    await c.getFailCount('healthy-ip');

    expect(c._sharedStoreDegradationForTest().degradedSince).toBeNull();
    expect(c._sharedStoreDegradationForTest().occurrences).toBe(0);
  });
});

describe('CAPTCHA provider config, middleware and admin observability branches', () => {
  const TURNSTILE = { CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 'turn-secret', TURNSTILE_SITEKEY: 'turn-site', HCAPTCHA_SECRET: undefined, HCAPTCHA_SITEKEY: undefined };

  it('public config exposes enabled Turnstile without leaking its secret', () => {
    const c = loadCaptcha(TURNSTILE);
    expect(c.getPublicConfig()).toEqual(expect.objectContaining({ enabled: true, provider: 'turnstile', sitekey: 'turn-site' }));
    expect(JSON.stringify(c.getPublicConfig())).not.toContain('turn-secret');
  });

  it('public config prefers hCaptcha and exposes only its site key', () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', HCAPTCHA_SECRET: 'h-secret', HCAPTCHA_SITEKEY: 'h-site', TURNSTILE_SECRET: 'turn-secret' });
    expect(c.getPublicConfig()).toEqual(expect.objectContaining({ enabled: true, provider: 'hcaptcha', sitekey: 'h-site' }));
  });

  it('admin stats reports memory/redis mode and active lock state', async () => {
    const c = loadCaptcha({ MAX_FAILED_LOGINS: '1', LOGIN_LOCKOUT_MS: '60000' });
    await c.recordFailedLogin('locked-stat-ip');
    const stats = await c.getAdminStats();
    expect(stats.store).toBe('memory');
    expect(stats.lockedIps.some((x) => x.ip === 'locked-stat-ip' && x.remainingSec > 0)).toBe(true);
  });

  it('enabled captchaMiddleware accepts a provider success and rejects provider failure', async () => {
    const c = loadCaptcha(TURNSTILE);
    mockFetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    let r = res(); let n = jest.fn() as unknown as NextFunction;
    c.captchaMiddleware(req({}, { body: { captchaToken: 'ok-token' } }), r, n);
    await new Promise(setImmediate);
    expect(n).toHaveBeenCalledTimes(1);

    mockFetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ success: false }) });
    r = res(); n = jest.fn() as unknown as NextFunction;
    c.captchaMiddleware(req({}, { body: { 'cf-turnstile-response': 'bad-token' } }), r, n);
    await new Promise(setImmediate);
    expect(r.statusCode).toBe(400);
    expect(n).not.toHaveBeenCalled();
  });

  it('no-Redis optional-cache failure keeps the documented single-node protection active', async () => {
    const c = loadCaptcha({ ...TURNSTILE, PROGRESSIVE_CAPTCHA_THRESHOLD: '1' });
    mockCache.get.mockRejectedValue(new Error('store unavailable'));
    mockCache.set.mockRejectedValue(new Error('store unavailable'));
    await c.recordFailedLogin('203.0.113.9');

    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.progressiveCaptchaMiddleware(req({}, { body: {} }), r, n);
    await new Promise(setImmediate);
    expect(r.statusCode).toBe(400);
    expect((r.body as { requireCaptcha?: boolean }).requireCaptcha).toBe(true);
    expect(n).not.toHaveBeenCalled();
  });

  it('progressive captcha validates an explicitly supplied token after threshold', async () => {
    const c = loadCaptcha({ ...TURNSTILE, PROGRESSIVE_CAPTCHA_THRESHOLD: '1' });
    await c.recordFailedLogin('203.0.113.9');
    mockFetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.progressiveCaptchaMiddleware(req({}, { body: { captchaToken: 'progressive-ok' } }), r, n);
    await new Promise(setImmediate);
    expect(n).toHaveBeenCalledTimes(1);
  });

  it('suspicious-login mail delivery failure remains advisory', async () => {
    const c = loadCaptcha();
    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(true);
    mockSendAlert.mockRejectedValueOnce(new Error('smtp down'));
    await expect(c.checkSuspiciousLogin(req(), { _id: 'mail-fail-u', email: 'u@example.com', username: '', displayName: '' })).resolves.toBeUndefined();
  });
});

describe('CAPTCHA/login quota atomic mutation contracts', () => {
  it('concurrent failed-login writes do not lose increments in single-node fallback', async () => {
    const c = loadCaptcha({ MAX_FAILED_LOGINS: '100' });
    await Promise.all(Array.from({ length: 20 }, () => c.recordFailedLogin('atomic-login-ip')));
    expect(await c.getFailCount('atomic-login-ip')).toBe(20);
  });

  it('concurrent registration reservations admit at most the configured quota', async () => {
    const c = loadCaptcha({ MAX_REG_PER_HOUR: '3' });
    const results = await Promise.all(Array.from({ length: 12 }, () => c.claimRegistrationSlot('atomic-reg-ip')));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await c.isRegistrationThrottled('atomic-reg-ip')).toBe(true);
  });

  it('configured Redis outage fails closed instead of multiplying security quotas per node', async () => {
    const c = loadCaptcha({ REDIS_URL: 'redis://configured-but-unavailable:6379' });
    await expect(c.recordFailedLogin('cluster-ip')).rejects.toThrow(/Redis CAPTCHA coordination unavailable/);
    const r = res(); const n = jest.fn() as unknown as NextFunction;
    c.loginLockMiddleware(req(), r, n);
    await new Promise(setImmediate);
    expect(r.statusCode).toBe(503);
    expect(n).not.toHaveBeenCalled();
  });
});
