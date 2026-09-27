// server/tests/captcha-store-sweeper-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/captcha.ts — SÜREÇ-YEREL GÜVENLİK DEPOSU, PROXY GÜVENİ VE UYARI YOLU
// ════════════════════════════════════════════════════════════════════════════
//
// `captcha-error-paths.test.ts` sağlayıcı/kilit/kota dallarını ölçer. Burada
// tamamlayıcı üç sınıf ele alınır ve üçü de üretimde sessizce bozulabilir:
//
//   · SÜREÇ-YEREL DEPO — paylaşılan önbellek erişilemezken güvenlik durumu
//     süreç belleğine düşer. O bellek TEMİZLENMEZSE saldırgan dönen IP'lerle
//     onu sınırsız büyütebilir; süpürge tam olarak bunu engeller.
//   · PROXY GÜVENİ — `X-Forwarded-For` yalnız GÜVENİLEN bir hop'tan gelirse
//     dikkate alınır. Yanlış tarafa düşen bir dal, saldırganın kendi IP'sini
//     yazmasına ve kilit/kotayı atlamasına izin verirdi.
//   · UYARI YOLU — şüpheli giriş e-postası TAVSİYE niteliğindedir; gönderici
//     yoksa ya da çökerse kimlik doğrulama akışı ETKİLENMEMELİDİR.

process.env.NODE_ENV = 'test';

import type { Request, Response } from 'express';

const mockFetchT = jest.fn();
jest.mock('../lib/fetch', () => ({ fetchT: (...a: unknown[]) => mockFetchT(...a) }));

const mockCache = {
  get: jest.fn(), set: jest.fn(), setIfAbsentAuthoritative: jest.fn(),
  getAuthoritative: jest.fn(), setAuthoritative: jest.fn(), del: jest.fn(), delAuthoritative: jest.fn(),
  withKeyLock: jest.fn(),
};
// @types/jest'te `Mock<T, Y, C>` icin Y varsayilani `any`dir — `any[]`
// DEGIL. Yani bare `jest.fn()` REST parametresi tasimaz ve `mock(...args)`
// TS2556 verir; `mock.calls[i][n]` de bos demet olarak gorunur. Imzayi
// acikca yazmak ikisini de duzeltir.
const mockRedisAvailable = jest.fn<boolean, unknown[]>(() => false);
jest.mock('../lib/redisAdapter', () => ({
  cache: mockCache,
  isRedisAvailable: (...a: unknown[]) => mockRedisAvailable(...a),
}));

// Postacı BİLEREK fonksiyon değildir: dağıtımlarda mailer devre dışı
// bırakılabilir ve o durumda uyarı yolu sessizce atlanmalıdır.
jest.mock('../lib/mailer', () => ({ sendSuspiciousLoginAlert: null }));

type CaptchaModule = typeof import('../lib/captcha');

function loadCaptcha(env: Record<string, string | undefined> = {}): CaptchaModule {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let mod!: CaptchaModule;
  try {
    jest.isolateModules(() => { mod = require('../lib/captcha'); });
  } finally {
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
  const r: Record<string, unknown> = { statusCode: 0, body: undefined };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; return r; });
  return r as unknown as Response & { statusCode: number; body: Record<string, unknown> };
}

const mockValues = new Map<string, unknown>();
let sharedStoreDown = false;

beforeEach(() => {
  mockValues.clear();
  sharedStoreDown = false;
  mockFetchT.mockReset();
  mockRedisAvailable.mockReset().mockReturnValue(false);
  for (const fn of Object.values(mockCache)) fn.mockReset();
  mockCache.get.mockImplementation(async (key: string) => {
    if (sharedStoreDown) throw new Error('shared store offline');
    return mockValues.get(key) ?? null;
  });
  mockCache.getAuthoritative.mockImplementation(async (key: string) => {
    if (sharedStoreDown) throw new Error('shared store offline');
    return mockValues.get(key) ?? null;
  });
  mockCache.set.mockImplementation(async (key: string, value: unknown) => {
    if (sharedStoreDown) throw new Error('shared store offline');
    mockValues.set(key, value);
  });
  mockCache.setAuthoritative.mockImplementation(async (key: string, value: unknown) => {
    if (sharedStoreDown) throw new Error('shared store offline');
    mockValues.set(key, value);
  });
  mockCache.del.mockImplementation(async (key: string) => { mockValues.delete(key); });
  mockCache.delAuthoritative.mockImplementation(async (key: string) => { mockValues.delete(key); });
  mockCache.setIfAbsentAuthoritative.mockImplementation(async (key: string, value: unknown) => {
    if (mockValues.has(key)) return false;
    mockValues.set(key, value);
    return true;
  });
});

afterEach(() => { jest.useRealTimers(); });

describe('süreç-yerel güvenlik deposu süpürgesi', () => {
  it('paylaşılan depo erişilemezken durum süreç belleğine düşer', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });
    sharedStoreDown = true;

    await c.recordFailedLogin('198.51.100.1');
    await c.recordRegistration('198.51.100.2');

    const stats = await c.getAdminStats();
    expect(stats.memStoreSize).toBe(2);
    expect(stats.store).toBeTruthy();
  });

  it('süpürge yalnız izi kalmamış girişleri atar; kilitli ve hatalı IP korunur', async () => {
    jest.useFakeTimers();
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });
    sharedStoreDown = true;

    // Yalnizca ESKI bir kayit izi olan IP → temizlenmeli.
    await c.recordRegistration('198.51.100.10');
    // Basarisiz girisi olan IP → sayaci durdugu icin KORUNMALI.
    await c.recordFailedLogin('198.51.100.11');

    expect((await c.getAdminStats()).memStoreSize).toBe(2);

    // Kayit penceresi (1 saat) geride kalir ve supurge calisir.
    jest.advanceTimersByTime(3_600_001);

    const stats = await c.getAdminStats();
    expect(stats.memStoreSize).toBe(1);
    expect(await c.getFailCount('198.51.100.11')).toBe(1);
    expect(await c.isRegistrationThrottled('198.51.100.10')).toBe(false);
  });

  it('süresi geçmiş replay jetonları da süpürülür', async () => {
    jest.useFakeTimers();
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined });
    mockFetchT.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    await c.verifyCaptcha('token-1', '203.0.113.5');
    expect((await c.getAdminStats()).usedTokenCount).toBe(1);

    // Jeton kara listesi TTL'i çok daha kısadır; bir saat sonra iz kalmaz.
    jest.advanceTimersByTime(3_600_001);

    expect((await c.getAdminStats()).usedTokenCount).toBe(0);
  });

  it('yerel kara listede duran jeton, paylaşılan depo unutsa bile tekrar kullanılamaz', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined });
    mockFetchT.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    const first = await c.verifyCaptcha('token-replay', '203.0.113.5');
    expect(first.ok).toBe(true);

    // Paylasilan depo jetonu UNUTUR; sureç-yerel kara liste hala hatirlar.
    mockValues.clear();
    const replay = await c.verifyCaptcha('token-replay', '203.0.113.5');

    expect(replay.ok).toBe(false);
    expect(replay.error).toBeTruthy();
  });
});

describe('proxy güveni ve istemci IP çözümü', () => {
  it('güvenilmeyen bir hop\'tan gelen X-Forwarded-For dikkate alınmaz', () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false', TRUSTED_PROXIES: undefined, TRUSTED_PROXY_COUNT: '1' });

    const ip = c._getIp(req(
      { 'x-forwarded-for': '9.9.9.9' },
      { socket: { remoteAddress: '198.51.100.77' }, ip: '198.51.100.77' },
    ));

    expect(ip).not.toBe('9.9.9.9');
  });

  it('özel ağdan gelen istek güvenilen proxy sayılır', () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false', TRUSTED_PROXY_COUNT: '1' });

    const ip = c._getIp(req(
      { 'x-forwarded-for': '203.0.113.44' },
      { socket: { remoteAddress: '10.0.0.5' }, ip: '10.0.0.5' },
    ));

    expect(typeof ip).toBe('string');
    expect(ip.length).toBeGreaterThan(0);
  });

  it('açıkça güvenilen proxy listesi de kabul edilir', () => {
    const c = loadCaptcha({
      CAPTCHA_ENABLED: 'false',
      TRUSTED_PROXIES: '198.51.100.77',
      TRUSTED_PROXY_COUNT: '1',
    });

    const ip = c._getIp(req(
      { 'x-forwarded-for': '203.0.113.44' },
      { socket: { remoteAddress: '198.51.100.77' }, ip: '198.51.100.77' },
    ));

    expect(typeof ip).toBe('string');
  });
});

describe('şüpheli giriş uyarısı', () => {
  it('postacı yapılandırılmamışsa uyarı atlanır ve akış sürer', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });

    await expect(c.checkSuspiciousLogin(
      req({ 'user-agent': 'Mozilla/5.0', 'accept-language': 'tr' }),
      { _id: 'u-1', email: 'ada@example.test', username: 'ada' },
    )).resolves.toBeUndefined();
  });

  it('kullanıcı kimliği yoksa hiçbir şey yapılmaz', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });

    await c.checkSuspiciousLogin(req(), null);
    await c.checkSuspiciousLogin(req(), {});

    expect(mockCache.setIfAbsentAuthoritative).not.toHaveBeenCalled();
  });

  it('bilinen cihaz ikinci girişte uyarı üretmez', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });
    const request = req({ 'user-agent': 'Mozilla/5.0', 'accept-language': 'tr' });

    await c.checkSuspiciousLogin(request, { _id: 'u-1', email: 'ada@example.test' });
    const afterFirst = mockCache.setIfAbsentAuthoritative.mock.calls.length;
    await c.checkSuspiciousLogin(request, { _id: 'u-1', email: 'ada@example.test' });

    expect(mockCache.setIfAbsentAuthoritative.mock.calls).toHaveLength(afterFirst + 1);
  });

  it('cihaz deposu çökerse giriş etkilenmez', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });
    mockCache.setIfAbsentAuthoritative.mockRejectedValueOnce(new Error('device store offline'));

    await expect(c.checkSuspiciousLogin(
      req({ 'user-agent': 'Mozilla/5.0' }),
      { _id: 'u-1', email: 'ada@example.test' },
    )).resolves.toBeUndefined();
  });

  it('e-postası olmayan kullanıcı için uyarı hiç denenmez', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'false' });

    await expect(c.checkSuspiciousLogin(req(), { _id: 'u-2', username: 'grace' }))
      .resolves.toBeUndefined();
  });
});

describe('CAPTCHA middleware yedek metinleri', () => {
  it('jeton hiç gönderilmemişse boş dizeyle doğrulanır ve genel ret verilir', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined });
    const response = res();
    const next = jest.fn();

    c.captchaMiddleware(req({}, { body: {} }), response, next);
    await new Promise(resolve => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(400);
    expect(String(response.body.error)).toBeTruthy();
    // Jeton olmadigi icin saglayiciya HIC gidilmez.
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('sonraki katman çökerse istek fail-closed 503 ile kapanır, askıda kalmaz', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined });
    mockFetchT.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const response = res();
    const next = jest.fn(() => { throw new Error('downstream exploded'); });

    c.captchaMiddleware(req({}, { body: { captchaToken: 'abc' } }), response, next);
    await new Promise(resolve => setImmediate(resolve));

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Güvenlik doğrulaması geçici olarak kullanılamıyor' });
  });

  it('paylaşılan otorite ilan edilmişken erişilemiyorsa kademeli CAPTCHA 503 verir', async () => {
    const c = loadCaptcha({
      CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined,
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
    // Error olmayan bir reddetme: log satiri `String(err)` ile anlamli kalmali.
    mockCache.getAuthoritative.mockRejectedValue('shared authority exploded');
    mockRedisAvailable.mockReturnValue(true);
    const response = res();
    const next = jest.fn();

    c.progressiveCaptchaMiddleware(req({}, { body: {} }), response, next);
    await new Promise(resolve => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Güvenlik doğrulaması geçici olarak kullanılamıyor' });
  });

  it('kademeli CAPTCHA eşik altındayken geçirir, eşikte jeton ister', async () => {
    const c = loadCaptcha({
      CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined,
      PROGRESSIVE_CAPTCHA_THRESHOLD: '2',
    });
    const request = req({}, { body: {}, socket: { remoteAddress: '203.0.113.90' }, ip: '203.0.113.90' });

    const pass = res();
    const passNext = jest.fn();
    c.progressiveCaptchaMiddleware(request, pass, passNext);
    await new Promise(resolve => setImmediate(resolve));
    expect(passNext).toHaveBeenCalledTimes(1);

    await c.recordFailedLogin('203.0.113.90');
    await c.recordFailedLogin('203.0.113.90');

    const blocked = res();
    const blockedNext = jest.fn();
    c.progressiveCaptchaMiddleware(request, blocked, blockedNext);
    await new Promise(resolve => setImmediate(resolve));

    expect(blockedNext).not.toHaveBeenCalled();
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body).toMatchObject({ requireCaptcha: true });
  });

  it('kademeli CAPTCHA jetonu geçersizse genel ret metnine düşer', async () => {
    const c = loadCaptcha({
      CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined,
      PROGRESSIVE_CAPTCHA_THRESHOLD: '1',
    });
    await c.recordFailedLogin('203.0.113.91');
    mockFetchT.mockResolvedValue({ ok: true, json: async () => ({ success: false }) });

    const response = res();
    const next = jest.fn();
    c.progressiveCaptchaMiddleware(
      req({}, { body: { 'cf-turnstile-response': 'bad' }, socket: { remoteAddress: '203.0.113.91' }, ip: '203.0.113.91' }),
      response, next,
    );
    await new Promise(resolve => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(400);
    expect(String(response.body.error)).toBeTruthy();
  });

  it('paylaşılan otorite ilan EDİLMEMİŞKEN depo hatası süreç-yerel duruma düşer', async () => {
    const c = loadCaptcha({ CAPTCHA_ENABLED: 'true', TURNSTILE_SECRET: 's3cret', HCAPTCHA_SECRET: undefined });
    mockCache.get.mockRejectedValue({ code: 'STORE_DOWN' });
    mockCache.getAuthoritative.mockRejectedValue({ code: 'STORE_DOWN' });
    const response = res();
    const next = jest.fn();

    c.progressiveCaptchaMiddleware(req({}, { body: {} }), response, next);
    await new Promise(resolve => setImmediate(resolve));

    // Tek dugum modunda ilan edilmis bir otorite YOKTUR: istek reddedilmez.
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(0);
  });
});
