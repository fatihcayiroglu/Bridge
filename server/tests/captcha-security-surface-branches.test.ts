// server/tests/captcha-security-surface-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// CAPTCHA / GİRİŞ GÜVENLİĞİ YÜZEYİ — KARAR DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// Bu modül kimlik doğrulamanın ÖNÜNDEKİ kapıdır. Ölçülmemiş dalların her biri
// ya kapıyı sessizce açar ya da meşru kullanıcıyı dışarıda bırakır:
//
//   · REPLAY — sağlayıcı "başarılı" dese bile jeton PAYLAŞILAN depoda ATOMİK
//     olarak sahiplenilmelidir; aksi hâlde iki düğüm aynı yanıtı kabul eder.
//   · DEPO BELİRSİZLİĞİ — replay deposu okunamıyorsa doğrulama BAŞARILI
//     sayılmamalıdır (fail-closed), "erişilemedi, geç" değil.
//   · MIDDLEWARE ÇÖKÜŞÜ — güvenlik middleware'i patlarsa istek 503 ile
//     REDDEDİLİR; `next()` çağrılmaz.
//   · KOTA — kayıt kotası ve giriş kilidi, süresi geçmiş kayıtları temizleyip
//     kalanları saymalıdır; yoksa kota kalıcı olarak kapanır ya da hiç kapanmaz.
//   · ŞÜPHELİ GİRİŞ — bilinen-cihaz deposu patlarsa kullanıcıya HER girişte
//     uyarı yağmaz; uyarı danışma niteliğindedir ve girişi ENGELLEMEZ.

process.env.NODE_ENV = 'test';
process.env.CAPTCHA_ENABLED = 'true';
process.env.HCAPTCHA_SECRET = 'test-hcaptcha-secret';
process.env.MAX_FAILED_LOGINS = '3';
process.env.MAX_REG_PER_HOUR = '2';
process.env.PROGRESSIVE_CAPTCHA_THRESHOLD = '2';
delete process.env.REDIS_URL;

const fetchT = jest.fn();
const cacheStore = new Map<string, unknown>();
const cacheMock = {
  get: jest.fn(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null)),
  set: jest.fn(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
  getAuthoritative: jest.fn(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null)),
  setAuthoritative: jest.fn(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
  setIfAbsentAuthoritative: jest.fn(async (key: string, value: unknown) => {
    if (cacheStore.has(key)) return false;
    cacheStore.set(key, value);
    return true;
  }),
  withKeyLock: jest.fn(async <T>(_key: string, fn: () => Promise<T>) => fn()),
};
const redisAvailable = jest.fn(() => false);
// @types/jest'te `Mock<T, Y, C>` icin Y varsayilani `any`dir — `any[]`
// DEGIL. Yani bare `jest.fn()` REST parametresi tasimaz ve `mock(...args)`
// TS2556 verir; `mock.calls[i][n]` de bos demet olarak gorunur. Imzayi
// acikca yazmak ikisini de duzeltir.
const sendAlert = jest.fn<Promise<unknown>, unknown[]>();
const clientIp = jest.fn<string, unknown[]>(() => '203.0.113.7');

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/redisAdapter', () => ({
  cache: cacheMock,
  isRedisAvailable: () => redisAvailable(),
}));
jest.mock('../lib/mailer', () => ({ sendSuspiciousLoginAlert: (...args: unknown[]) => sendAlert(...args) }));
jest.mock('../lib/clientIp', () => ({ getClientIp: (...args: unknown[]) => clientIp(...args) }));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { NextFunction, Request, Response } from 'express';
import {
  botFilterMiddleware,
  captchaMiddleware,
  checkSuspiciousLogin,
  claimRegistrationSlot,
  getAdminStats,
  getBotScore,
  getFailCount,
  isLoginLocked,
  isRegistrationThrottled,
  loginLockMiddleware,
  loginLockRemainingMs,
  progressiveCaptchaMiddleware,
  recordFailedLogin,
  recordRegistration,
  recordSuccessfulLogin,
  registrationThrottleMiddleware,
  shouldShowLoginCaptcha,
  verifyCaptcha,
  _getIp,
} from '../lib/captcha';

const IP = '203.0.113.7';

function providerResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function makeReq(over: Partial<Request> = {}): Request {
  // Express `Request` yüzlerce üye taşır; bu modül yalnız `headers`, `method`
  // ve `body` okur. Dönüşüm tek noktada ve açıkça yapılır.
  return { headers: {}, method: 'GET', body: {}, ...over } as unknown as Request;
}

function makeRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(async () => {
  jest.clearAllMocks();
  cacheStore.clear();
  redisAvailable.mockReturnValue(false);
  clientIp.mockReturnValue(IP);
  fetchT.mockResolvedValue(providerResponse({ success: true }));
  // Süreç-içi durum test dosyası boyunca paylaşılır; her testin kendi IP'si
  // olmasını sağlamak yerine oturumu açık biçimde sıfırlıyoruz.
  await recordSuccessfulLogin(IP);
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyCaptcha', () => {
  it('jeton yoksa doğrulama BAŞARISIZDIR', async () => {
    expect(await verifyCaptcha('', IP)).toEqual({ ok: false, error: 'CAPTCHA token eksik' });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('sağlayıcıya UZAK IP boş geçilebilir ama gövde yine kurulur', async () => {
    await verifyCaptcha('tok-1', '');

    const [url, init] = fetchT.mock.calls[0] as [string, { body: URLSearchParams }];
    expect(url).toBe('https://api.hcaptcha.com/siteverify');
    expect(init.body.get('secret')).toBe('test-hcaptcha-secret');
    expect(init.body.get('remoteip')).toBe('');
  });

  it('KULLANILMIŞ jeton yeniden kabul edilmez', async () => {
    await verifyCaptcha('tok-replay', IP);
    fetchT.mockClear();

    const second = await verifyCaptcha('tok-replay', IP);

    expect(second).toEqual({ ok: false, error: 'CAPTCHA süresi doldu, tekrar deneyin' });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('replay deposu OKUNAMAZSA doğrulama reddedilir (fail-closed)', async () => {
    cacheMock.getAuthoritative.mockRejectedValueOnce(new Error('redis down'));

    expect(await verifyCaptcha('tok-2', IP)).toEqual({
      ok: false, error: 'CAPTCHA güvenlik deposu geçici olarak kullanılamıyor',
    });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('jeton SAHİPLENİLEMEZSE doğrulama reddedilir', async () => {
    cacheMock.setIfAbsentAuthoritative.mockRejectedValueOnce(new Error('redis down'));

    expect(await verifyCaptcha('tok-3', IP)).toEqual({
      ok: false, error: 'CAPTCHA güvenlik deposu geçici olarak kullanılamıyor',
    });
  });

  it('YARIŞTA ikinci düğüm jetonu sahiplenemez', async () => {
    cacheMock.setIfAbsentAuthoritative.mockResolvedValueOnce(false);

    expect(await verifyCaptcha('tok-4', IP)).toEqual({
      ok: false, error: 'CAPTCHA süresi doldu, tekrar deneyin',
    });
  });

  it('sağlayıcıya ulaşılamazsa reddedilir', async () => {
    fetchT.mockResolvedValue(providerResponse({}, false));

    expect(await verifyCaptcha('tok-5', IP)).toEqual({
      ok: false, error: 'CAPTCHA servisine ulaşılamadı',
    });
  });

  it.each([
    [['timeout-or-duplicate'], 'CAPTCHA süresi doldu, tekrar deneyin'],
    [['invalid-input-response'], 'Geçersiz CAPTCHA, tekrar deneyin'],
    [['bad-request'], 'CAPTCHA doğrulanamadı'],
    [undefined, 'CAPTCHA doğrulanamadı'],
  ])('sağlayıcı hata kodu %j ayırt edilir', async (codes, error) => {
    fetchT.mockResolvedValue(providerResponse({ success: false, 'error-codes': codes }));

    expect(await verifyCaptcha('tok-6', IP)).toEqual({ ok: false, error });
  });

  it('geliştirme ortamında ağ hatası ATLANIR, üretimde REDDEDİLİR', async () => {
    fetchT.mockRejectedValue(new Error('ağ yok'));
    expect(await verifyCaptcha('tok-7', IP)).toEqual({ ok: true, skip: true });

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(await verifyCaptcha('tok-8', IP)).toEqual({
        ok: false, error: 'CAPTCHA servisi geçici olarak kullanılamıyor',
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('başarılı doğrulama jetonu sahiplenir', async () => {
    expect(await verifyCaptcha('tok-9', IP)).toEqual({ ok: true });
    expect(cacheMock.setIfAbsentAuthoritative).toHaveBeenCalledWith(
      expect.stringContaining('captcha:token:'), 1, expect.any(Number),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('giriş kilidi', () => {
  const LOCK_IP = '198.51.100.5';

  beforeEach(async () => { await recordSuccessfulLogin(LOCK_IP); });

  it('eşik altındaki başarısız girişler kilitlemez', async () => {
    await recordFailedLogin(LOCK_IP);
    await recordFailedLogin(LOCK_IP);

    expect(await getFailCount(LOCK_IP)).toBe(2);
    expect(await isLoginLocked(LOCK_IP)).toBe(false);
    expect(await loginLockRemainingMs(LOCK_IP)).toBe(0);
  });

  it('eşiğe ulaşan başarısız giriş KİLİTLER', async () => {
    for (let i = 0; i < 3; i += 1) await recordFailedLogin(LOCK_IP);

    expect(await isLoginLocked(LOCK_IP)).toBe(true);
    expect(await loginLockRemainingMs(LOCK_IP)).toBeGreaterThan(0);
  });

  it('BAŞARILI giriş sayacı ve kilidi temizler', async () => {
    for (let i = 0; i < 3; i += 1) await recordFailedLogin(LOCK_IP);
    await recordSuccessfulLogin(LOCK_IP);

    expect(await isLoginLocked(LOCK_IP)).toBe(false);
    expect(await getFailCount(LOCK_IP)).toBe(0);
  });

  it('SÜRESİ GEÇMİŞ kilit ilk okumada kendiliğinden düşer', async () => {
    cacheStore.set(`captcha:ip:${LOCK_IP}`, { fails: 9, lockedUntil: Date.now() - 1_000, regs: [] });

    expect(await isLoginLocked(LOCK_IP)).toBe(false);
    expect(await getFailCount(LOCK_IP)).toBe(0);
  });

  it('BOZUK kalıcı durum yerel duruma düşer, çökmez', async () => {
    cacheStore.set(`captcha:ip:${LOCK_IP}`, { fails: 'çok', lockedUntil: 0, regs: [] });

    expect(await getFailCount(LOCK_IP)).toBe(0);
  });

  it('ilerlemeli CAPTCHA eşiği aşılınca istenir', async () => {
    expect(await shouldShowLoginCaptcha(LOCK_IP)).toBe(false);
    await recordFailedLogin(LOCK_IP);
    await recordFailedLogin(LOCK_IP);
    expect(await shouldShowLoginCaptcha(LOCK_IP)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kayıt kotası', () => {
  const REG_IP = '198.51.100.9';

  beforeEach(() => { cacheStore.delete(`captcha:ip:${REG_IP}`); });

  it('kota dolmadan kayıt yeri ayrılabilir', async () => {
    expect(await claimRegistrationSlot(REG_IP)).toBe(true);
    expect(await claimRegistrationSlot(REG_IP)).toBe(true);
    expect(await isRegistrationThrottled(REG_IP)).toBe(true);
    expect(await claimRegistrationSlot(REG_IP)).toBe(false);
  });

  it('BİR SAATTEN eski kayıtlar kotadan düşer', async () => {
    cacheStore.set(`captcha:ip:${REG_IP}`, {
      fails: 0, lockedUntil: 0,
      regs: [Date.now() - 3_600_001, Date.now() - 7_200_000],
    });

    expect(await isRegistrationThrottled(REG_IP)).toBe(false);
    expect(await claimRegistrationSlot(REG_IP)).toBe(true);
  });

  it('recordRegistration eski kayıtları temizleyerek yazar', async () => {
    cacheStore.set(`captcha:ip:${REG_IP}`, { fails: 0, lockedUntil: 0, regs: [Date.now() - 3_600_001] });

    await recordRegistration(REG_IP);

    const stored = cacheStore.get(`captcha:ip:${REG_IP}`) as { regs: number[] };
    expect(stored.regs).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('şüpheli giriş uyarısı', () => {
  const req = () => makeReq({ headers: { 'user-agent': 'Mozilla/5.0 Chrome', 'accept-language': 'tr' } });

  it('kullanıcı yoksa hiçbir şey yapılmaz', async () => {
    await checkSuspiciousLogin(req(), null);
    await checkSuspiciousLogin(req(), { username: 'kimliksiz' });

    expect(cacheMock.setIfAbsentAuthoritative).not.toHaveBeenCalled();
  });

  it('BİLİNEN cihazda uyarı gönderilmez', async () => {
    await checkSuspiciousLogin(req(), { _id: 'u1', email: 'a@x.test' });
    sendAlert.mockClear();

    await checkSuspiciousLogin(req(), { _id: 'u1', email: 'a@x.test' });

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('cihaz deposu PATLARSA uyarı yağmaz ve giriş etkilenmez', async () => {
    cacheMock.setIfAbsentAuthoritative.mockRejectedValueOnce(new Error('redis down'));

    await expect(checkSuspiciousLogin(req(), { _id: 'u2', email: 'a@x.test' })).resolves.toBeUndefined();

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('e-postası olmayan kullanıcıya uyarı gönderilmez', async () => {
    await checkSuspiciousLogin(req(), { _id: 'u3', username: 'epostasiz' });

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('YENİ cihazda uyarı gönderilir ve ad için yedekler kullanılır', async () => {
    await checkSuspiciousLogin(req(), { _id: 'u4', email: 'sadece@eposta.test' });

    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({
      to: 'sadece@eposta.test', username: 'sadece@eposta.test', ip: IP,
    }));
  });

  it('görünen ad varsa uyarıda o kullanılır', async () => {
    await checkSuspiciousLogin(req(), { _id: 'u5', email: 'a@x.test', displayName: 'Görünen', username: 'kadi' });

    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ username: 'Görünen' }));
  });

  it('kullanıcı ajanı yoksa uyarıda BİLİNMİYOR yazar', async () => {
    await checkSuspiciousLogin(makeReq(), { _id: 'u6', email: 'a@x.test' });

    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ userAgent: 'Bilinmiyor' }));
  });

  it('uyarı gönderimi PATLARSA giriş yine tamamlanır', async () => {
    sendAlert.mockRejectedValueOnce(new Error('smtp down'));

    await expect(checkSuspiciousLogin(req(), { _id: 'u7', email: 'a@x.test' })).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bot puanı', () => {
  it('eksik ve şüpheli başlıklar puanı yükseltir', () => {
    expect(getBotScore(makeReq())).toBeGreaterThanOrEqual(80);
    expect(getBotScore(makeReq({ headers: { 'user-agent': 'curl/8.0' } }))).toBeGreaterThanOrEqual(50);
  });

  it('REFERER olmadan ORIGIN gönderen istek ek puan alır', () => {
    const base = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/120.0',
      'accept-language': 'tr', accept: 'text/html', 'accept-encoding': 'gzip', connection: 'keep-alive',
    };
    const withReferer = getBotScore(makeReq({ headers: { ...base, referer: 'https://x.test', origin: 'https://x.test' } }));
    const withoutReferer = getBotScore(makeReq({ headers: { ...base, origin: 'https://x.test' } }));

    expect(withoutReferer - withReferer).toBe(5);
  });

  it('Chrome iddiasında sec-fetch başlıkları YOKSA ek puan verilir', () => {
    const chrome = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'accept-language': 'tr', accept: 'text/html', 'accept-encoding': 'gzip', connection: 'keep-alive',
      referer: 'https://x.test',
    };
    const suspicious = getBotScore(makeReq({ headers: chrome }));
    const legitimate = getBotScore(makeReq({
      headers: { ...chrome, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    }));

    expect(suspicious - legitimate).toBe(15);
  });

  it('gövdesiz POST ve kısa Mozilla iddiası cezalandırılır', () => {
    expect(getBotScore(makeReq({ method: 'POST', headers: { 'user-agent': 'mozilla/5.0' } })))
      .toBeGreaterThanOrEqual(20);
  });

  it('istemci IP çözümü sonuç vermezse BİLİNMEYEN kullanılır', () => {
    clientIp.mockReturnValue('');
    expect(_getIp(makeReq())).toBe('unknown');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('middleware sınırları', () => {
  it('captchaMiddleware jetonu üç ayrı gövde alanından okur', async () => {
    for (const key of ['captchaToken', 'h-captcha-response', 'cf-turnstile-response']) {
      fetchT.mockResolvedValue(providerResponse({ success: true }));
      const next = jest.fn() as NextFunction;
      const { res } = makeRes();

      captchaMiddleware(makeReq({ body: { [key]: `tok-${key}` } }), res, next);
      await flush();

      expect(next).toHaveBeenCalled();
    }
  });

  it('captchaMiddleware doğrulama başarısızsa 400 verir', async () => {
    fetchT.mockResolvedValue(providerResponse({ success: false, 'error-codes': ['invalid-input-response'] }));
    const next = jest.fn() as NextFunction;
    const { res, status, json } = makeRes();

    captchaMiddleware(makeReq({ body: { captchaToken: 'tok-x' } }), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Geçersiz CAPTCHA, tekrar deneyin' });
  });

  it('progressiveCaptchaMiddleware eşik altında CAPTCHA İSTEMEZ', async () => {
    clientIp.mockReturnValue('198.51.100.20');
    const next = jest.fn() as NextFunction;
    const { res } = makeRes();

    progressiveCaptchaMiddleware(makeReq(), res, next);
    await flush();

    expect(next).toHaveBeenCalled();
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('progressiveCaptchaMiddleware eşik üstünde jeton ister', async () => {
    const ip = '198.51.100.21';
    clientIp.mockReturnValue(ip);
    await recordFailedLogin(ip); await recordFailedLogin(ip);
    const next = jest.fn() as NextFunction;
    const { res, status, json } = makeRes();

    progressiveCaptchaMiddleware(makeReq(), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ requireCaptcha: true }));
  });

  it('progressiveCaptchaMiddleware geçerli jetonla geçirir, geçersizle 400 verir', async () => {
    const ip = '198.51.100.22';
    clientIp.mockReturnValue(ip);
    await recordFailedLogin(ip); await recordFailedLogin(ip);

    const okNext = jest.fn() as NextFunction;
    progressiveCaptchaMiddleware(makeReq({ body: { captchaToken: 'tok-ok' } }), makeRes().res, okNext);
    await flush();
    expect(okNext).toHaveBeenCalled();

    fetchT.mockResolvedValue(providerResponse({ success: false, 'error-codes': [] }));
    const badNext = jest.fn() as NextFunction;
    const { res, status } = makeRes();
    progressiveCaptchaMiddleware(makeReq({ body: { captchaToken: 'tok-bad' } }), res, badNext);
    await flush();

    expect(badNext).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('loginLockMiddleware kilitli IP için 429 ve kalan süre verir', async () => {
    const ip = '198.51.100.23';
    clientIp.mockReturnValue(ip);
    for (let i = 0; i < 3; i += 1) await recordFailedLogin(ip);
    const next = jest.fn() as NextFunction;
    const { res, status, json } = makeRes();

    loginLockMiddleware(makeReq(), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ locked: true }));
  });

  it('loginLockMiddleware kilitsiz IP’yi geçirir', async () => {
    clientIp.mockReturnValue('198.51.100.24');
    const next = jest.fn() as NextFunction;

    loginLockMiddleware(makeReq(), makeRes().res, next);
    await flush();

    expect(next).toHaveBeenCalled();
  });

  it('botFilterMiddleware VARSAYILAN eşikle bariz botu engeller', () => {
    const next = jest.fn() as NextFunction;
    const { res, status } = makeRes();

    botFilterMiddleware()(makeReq({ headers: { 'user-agent': 'curl/8.0' } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it('botFilterMiddleware eşik yükseltilince geçirir', () => {
    const next = jest.fn() as NextFunction;

    botFilterMiddleware(1000)(makeReq({ headers: { 'user-agent': 'curl/8.0' } }), makeRes().res, next);

    expect(next).toHaveBeenCalled();
  });

  it('registrationThrottleMiddleware kota dolunca 429 verir', async () => {
    const ip = '198.51.100.25';
    clientIp.mockReturnValue(ip);
    await claimRegistrationSlot(ip); await claimRegistrationSlot(ip);
    const next = jest.fn() as NextFunction;
    const { res, status } = makeRes();

    registrationThrottleMiddleware(makeReq(), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(429);
  });

  it('registrationThrottleMiddleware kota varken geçirir', async () => {
    clientIp.mockReturnValue('198.51.100.26');
    const next = jest.fn() as NextFunction;

    registrationThrottleMiddleware(makeReq(), makeRes().res, next);
    await flush();

    expect(next).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yönetici istatistikleri', () => {
  it('depo türü Redis erişilebilirliğine göre bildirilir', async () => {
    expect((await getAdminStats()).store).toBe('memory');

    redisAvailable.mockReturnValue(true);
    expect((await getAdminStats()).store).toBe('redis');
  });

  it('kilitli IP listesi kalan süreyle raporlanır', async () => {
    const ip = '198.51.100.30';
    clientIp.mockReturnValue(ip);
    cacheMock.get.mockRejectedValue(new Error('paylaşılan depo yok'));
    cacheMock.set.mockRejectedValue(new Error('paylaşılan depo yok'));
    try {
      for (let i = 0; i < 3; i += 1) await recordFailedLogin(ip);

      const stats = await getAdminStats();
      const locked = stats.lockedIps.find(row => row.ip === ip);

      expect(locked).toBeDefined();
      expect(locked!.remainingSec).toBeGreaterThan(0);
      expect(stats.memStoreSize).toBeGreaterThan(0);
      expect(stats.captchaEnabled).toBe(true);
      expect(stats.provider).toBe('hcaptcha');
    } finally {
      cacheMock.get.mockImplementation(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null));
      cacheMock.set.mockImplementation(async (key: string, value: unknown) => { cacheStore.set(key, value); });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REDIS_URL tanımlıyken paylaşılan depo KANONİK otoritedir: süreç-içi belleğe
// seyreltme YOKTUR. Bu, modül yüklenirken okunan bir karardır; bu yüzden ayrı
// bir modül örneği kullanılır.
describe('paylaşılan depo KANONİK iken fail-closed', () => {
  type CaptchaModule = typeof import('../lib/captcha');
  let mod: CaptchaModule;
  let previousRedisUrl: string | undefined;

  beforeAll(() => {
    previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://localhost:6379';
    jest.isolateModules(() => {
      mod = require('../lib/captcha') as CaptchaModule;
    });
  });

  afterAll(() => {
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  });

  beforeEach(() => {
    redisAvailable.mockReturnValue(true);
    cacheMock.withKeyLock.mockImplementation(async <T>(_key: string, fn: () => Promise<T>) => fn());
    cacheMock.getAuthoritative.mockRejectedValue(new Error('redis down'));
    cacheMock.setAuthoritative.mockRejectedValue(new Error('redis down'));
  });

  it('okuma yolu BELLEĞE düşmez, hatayı yayar', async () => {
    await expect(mod.getFailCount(IP)).rejects.toThrow('redis down');
  });

  it('yazma yolu BELLEĞE düşmez, hatayı yayar', async () => {
    cacheMock.getAuthoritative.mockResolvedValue(null);
    await expect(mod.recordFailedLogin(IP)).rejects.toThrow('redis down');
  });

  it('Redis erişilemezken mutasyon KİLİDİ alınamaz', async () => {
    redisAvailable.mockReturnValue(false);
    await expect(mod.recordSuccessfulLogin(IP))
      .rejects.toThrow('Redis CAPTCHA coordination unavailable: login:203.0.113.7');
  });

  it('BOZUK kalıcı durum sessizce yok sayılmaz', async () => {
    cacheMock.getAuthoritative.mockResolvedValue({ fails: -1, lockedUntil: 0, regs: [] });
    await expect(mod.getFailCount(IP)).rejects.toThrow('Malformed CAPTCHA security state for 203.0.113.7');
  });

  it('progressiveCaptchaMiddleware fail-closed 503 verir', async () => {
    const next = jest.fn() as NextFunction;
    const { res, status } = makeRes();

    mod.progressiveCaptchaMiddleware(makeReq(), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
  });

  it('loginLockMiddleware fail-closed 503 verir', async () => {
    const next = jest.fn() as NextFunction;
    const { res, status } = makeRes();

    mod.loginLockMiddleware(makeReq(), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
  });

  it('registrationThrottleMiddleware fail-closed 503 verir', async () => {
    const next = jest.fn() as NextFunction;
    const { res, status } = makeRes();

    mod.registrationThrottleMiddleware(makeReq(), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
  });
});
