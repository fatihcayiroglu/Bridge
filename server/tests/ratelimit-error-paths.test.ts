// server/tests/ratelimit-error-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// middleware/rateLimit.ts — REDIS, OTOMATİK BAN VE ARIZA DALLARI
// ════════════════════════════════════════════════════════════════════════════
// Mevcut `tests/rateLimit.test.ts` sayma davranışını BELLEK deposunda ölçer.
// Üretimde ise sayaç REDIS'tedir ve bu dosyanın ölçtüğü dallar üretimde
// çalışan, testte hiç çalışmayan dallardı:
//
//   · Redis üzerinden sliding-window sayımı (zAdd/zRemRangeByScore/zCard)
//   · Redis ARIZASINDA belleğe düşüş — ve düşüşün SINIRI KALDIRMAMASI
//   · ihlal kaydının Redis'te tutulması, Redis yokken belleğe düşmesi
//   · tekrarlanan ihlallerde OTOMATİK IP BAN, ve ban altyapısı patlarsa
//     isteğin yine de 429 alması
//
// ── NEDEN BU DALLAR DİSPROPORSİYONEL DEĞERLİ ────────────────────────────────
// Bir rate limiter'ın en tehlikeli arıza biçimi ÇÖKMEK değil, SESSİZCE
// SAYMAYI BIRAKMAKTIR. Redis'e geçtikten sonra `catch` bloğu `null` döndürüp
// belleğe düşer; o düşüş yolu ölçülmemişse, Redis arızasında sınırın tamamen
// kalkıp kalkmadığını kimse bilmez. Aynı şekilde otomatik ban kodu bir
// `try/catch` içindedir: orada fırlayan bir hata 429'u yutarsa, limiter
// ihlalcinin isteğini KABUL ederek tam ters yönde çalışır.

process.env.NODE_ENV = 'test';
const originalRedisUrl = process.env.REDIS_URL;
delete process.env.REDIS_URL;

import request from 'supertest';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';

// ── Redis sınırı ────────────────────────────────────────────────────────────
let redisAvailable = false;
let redisClient: Record<string, unknown> | null = null;
const mockCacheIncrement = jest.fn();
const mockCacheDel = jest.fn();
jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => redisAvailable,
  redisClient: () => redisClient,
  redisAuthoritativeCommand: async (_operation: string, command: (client: unknown) => Promise<unknown>) => {
    if (!redisAvailable || !redisClient) throw new Error('Redis authoritative command unavailable');
    return command(redisClient);
  },
  cache: {
    get: jest.fn(),
    set: jest.fn(),
    setIfAbsent: jest.fn(),
    increment: (...a: unknown[]) => mockCacheIncrement(...a),
    del: (...a: unknown[]) => mockCacheDel(...a),
  },
}));

// ── Opsiyonel modüller (tryRequire ile yüklenir) ────────────────────────────
const mockGetBan = jest.fn();
const mockBanIp  = jest.fn();
jest.mock('../middleware/ipBan', () => ({
  getBan: (...a: unknown[]) => mockGetBan(...a),
  banIp:  (...a: unknown[]) => mockBanIp(...a),
}));

const mockTrackHit     = jest.fn();
const mockBumpAnomaly  = jest.fn();
const mockTrackAutoBan = jest.fn();
jest.mock('../middleware/metrics', () => ({
  trackRateLimitHit:   (...a: unknown[]) => mockTrackHit(...a),
  _bumpAnomalyCounter: (...a: unknown[]) => mockBumpAnomaly(...a),
  trackAutoBan:        (...a: unknown[]) => mockTrackAutoBan(...a),
}));

const {
  rateLimit,
  getViolationRecord,
  setViolationRecord,
  deleteViolationRecord,
  pruneMemStore,
  _resetRateLimitStoreForTest,
} = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');

/**
 * Gerçek `redis` istemcisinin sözleşmesini taklit eden, sıralı bir kayan
 * pencere. `zCard` sonucu pipeline'ın ÜÇÜNCÜ sonucudur — üretim kodu
 * `results[2]` okur, dolayısıyla sıra bir SÖZLEŞMEDİR.
 */
function makeRedisClient(opts: { failOn?: 'exec' | 'get' | 'set' | 'del'; execError?: unknown } = {}) {
  const sets = new Map<string, Array<{ score: number; value: string }>>();
  const kv   = new Map<string, string>();

  const client = {
    multi() {
      const ops: Array<() => unknown> = [];
      const pipe = {
        zAdd(key: string, m: { score: number; value: string }[]) {
          ops.push(() => { sets.set(key, [...(sets.get(key) ?? []), ...m]); return 1; });
          return pipe;
        },
        zRemRangeByScore(key: string, _min: string, max: number) {
          ops.push(() => {
            const before = sets.get(key) ?? [];
            sets.set(key, before.filter(e => e.score > max));
            return before.length - (sets.get(key) ?? []).length;
          });
          return pipe;
        },
        zCard(key: string) { ops.push(() => (sets.get(key) ?? []).length); return pipe; },
        expire()           { ops.push(() => 1); return pipe; },
        async exec() {
          if (opts.execError !== undefined) return Promise.reject(opts.execError);
          if (opts.failOn === 'exec') throw new Error('READONLY You can not write against a replica');
          return ops.map(op => op());
        },
      };
      return pipe;
    },
    async get(k: string) {
      if (opts.failOn === 'get') throw new Error('connection lost');
      return kv.get(k) ?? null;
    },
    async set(k: string, v: string) {
      if (opts.failOn === 'set') throw new Error('connection lost');
      kv.set(k, v); return 'OK';
    },
    async del(k: string) {
      if (opts.failOn === 'del') throw new Error('connection lost');
      kv.delete(k); return 1;
    },
    on() {}, async connect() {},
    _kv: kv, _sets: sets,
  };
  return client;
}

function buildApp(max: number, windowMs: number, prefix: string, opts: object = {}, uid?: string): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.defineProperty(req, 'ip', { value: '10.1.2.3', configurable: true });
    // Gercek kimlik dogrulama `JwtPayload` yazar; ikiz de ayni sozlesmeyi
    // doldurur. Eskiden yalnizca `{ id }` yaziliyor ve eksiklik bir tip
    // donusturmesiyle orluluyordu.
    if (uid) req.user = { id: uid, username: `user-${uid}`, v: 0 };
    next();
  });
  app.get('/t', rateLimit(max, windowMs, prefix, opts), (_req: Request, res: Response) => { res.json({ ok: true }); });
  return app;
}

/** Aynı app'e n istek at, dönen durum kodlarını sırayla ver. */
async function hit(app: Express, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await request(app).get('/t')).status);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  redisAvailable = false;
  redisClient = null;
  mockCacheIncrement.mockResolvedValue(1);
  mockCacheDel.mockResolvedValue(undefined);
  mockGetBan.mockResolvedValue(null);
  mockBanIp.mockResolvedValue(undefined);
  _resetRateLimitStoreForTest();
});

afterAll(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

// ════════════════════════════════════════════════════════════════════════════
describe('Redis destekli sayım', () => {
  beforeEach(() => { redisAvailable = true; redisClient = makeRedisClient(); });

  it('sayaç REDIS’te tutulur ve limit uygulanır', async () => {
    const app = buildApp(3, 60_000, 'redis-sayim');
    expect(await hit(app, 5)).toEqual([200, 200, 200, 429, 429]);
  });

  it('PENCERE DIŞINDAKİ girişler sayımdan düşer', async () => {
    // Kayan pencere sabit kova değildir: eski vuruşlar `zRemRangeByScore`
    // ile atılmazsa kullanıcı ilk pencereden sonra kalıcı olarak kilitlenir.
    const app = buildApp(2, 50, 'kayan');
    expect(await hit(app, 3)).toEqual([200, 200, 429]);
    await new Promise(r => setTimeout(r, 80));
    expect(await hit(app, 1)).toEqual([200]);
  });

  it('REDIS PATLARSA sınır KALKMAZ, belleğe düşer', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // `hitRedis` `catch` içinde `null` döner. `null` "sınırsız" diye
    // yorumlansaydı, Redis'i düşürebilen bir saldırgan tüm rate limiting'i
    // kapatabilirdi. Bellek yedeği sınırı AYNEN uygulamalı.
    redisClient = makeRedisClient({ failOn: 'exec' });
    const app = buildApp(3, 60_000, 'redis-arizasi');
    expect(await hit(app, 5)).toEqual([200, 200, 200, 429, 429]);
  });

  it('Redis YOKKEN (client null) bellek yedeği çalışır', async () => {
    redisAvailable = true;
    redisClient = null;
    const app = buildApp(2, 60_000, 'client-yok');
    expect(await hit(app, 3)).toEqual([200, 200, 429]);
  });

  it('yapılandırılmış Redis kullanılamıyorsa isteği 503 ile kapalı devre reddeder', async () => {
    process.env.REDIS_URL = 'redis://rate-authority.invalid:6379';
    jest.resetModules();
    redisAvailable = false;
    try {
      const isolated = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');
      const app = express();
      app.get('/t', isolated.rateLimit(3, 60_000, 'configured-down'), (_req: Request, res: Response) => res.json({ ok: true }));
      const response = await request(app).get('/t');
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.body).toEqual({ error: 'Rate limit service temporarily unavailable' });
    } finally {
      delete process.env.REDIS_URL;
      jest.resetModules();
    }
  });

  it('yapılandırılmış Redis hazırken kayan pencere canonical authoritative komut yolunu kullanır', async () => {
    process.env.REDIS_URL = 'redis://rate-authority.invalid:6379';
    jest.resetModules();
    redisAvailable = true;
    redisClient = makeRedisClient();
    try {
      const isolated = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');
      const app = express();
      app.get('/t', isolated.rateLimit(2, 60_000, 'configured-ready'), (_req: Request, res: Response) => res.json({ ok: true }));
      expect(await hit(app, 3)).toEqual([200, 200, 429]);
    } finally {
      delete process.env.REDIS_URL;
      jest.resetModules();
    }
  });

  it('yapılandırılmış Redis komutu non-Error ile reddedilse de kapalı devre kalır', async () => {
    process.env.REDIS_URL = 'redis://rate-authority.invalid:6379';
    jest.resetModules();
    redisAvailable = true;
    redisClient = makeRedisClient({ execError: 'socket closed without Error object' });
    try {
      const isolated = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');
      const app = express();
      app.get('/t', isolated.rateLimit(3, 60_000, 'configured-command-failure'), (_req: Request, res: Response) => res.json({ ok: true }));
      await expect(request(app).get('/t')).resolves.toMatchObject({ status: 503 });
    } finally {
      delete process.env.REDIS_URL;
      jest.resetModules();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ihlal kaydı deposu', () => {
  it('Redis VARSA kayıt Redis’e yazılır ve okunur', async () => {
    redisAvailable = true;
    const client = makeRedisClient();
    redisClient = client;

    await setViolationRecord('9.9.9.9', { count: 3, firstAt: 1000 });
    expect(client._kv.get('rl:violations:9.9.9.9')).toBe('{"count":3,"firstAt":1000}');
    expect(await getViolationRecord('9.9.9.9')).toEqual({ count: 3, firstAt: 1000 });

    await deleteViolationRecord('9.9.9.9');
    expect(client._kv.has('rl:violations:9.9.9.9')).toBe(false);
  });

  it('kayıt YOKSA null döner', async () => {
    redisAvailable = true;
    redisClient = makeRedisClient();
    expect(await getViolationRecord('1.1.1.1')).toBeNull();
  });

  it('Redis OKUMA patlarsa belleğe düşer (istisna sızmaz)', async () => {
    redisAvailable = true;
    redisClient = makeRedisClient({ failOn: 'get' });
    await expect(getViolationRecord('2.2.2.2')).resolves.toBeNull();
  });

  it('Redis YAZMA patlarsa kayıt bellekte tutulur (kayıp yok)', async () => {
    // Yazma hatası yutulup kayıt hiç tutulmasaydı, otomatik ban eşiği
    // asla dolmazdı — koruma sessizce ölürdü.
    redisAvailable = true;
    redisClient = makeRedisClient({ failOn: 'set' });
    await setViolationRecord('3.3.3.3', { count: 7, firstAt: 42 });

    redisClient = makeRedisClient({ failOn: 'get' });   // Redis hâlâ arızalı
    expect(await getViolationRecord('3.3.3.3')).toEqual({ count: 7, firstAt: 42 });
  });

  it('Redis SİLME patlarsa BELLEK kaydı yine temizlenir', async () => {
    // Redis kopyası TTL'ine (1 saat) kadar kalır — silme başarısız oldu.
    // Ölçülen davranış budur; burada iddia edilen, fonksiyonun FİRLATMAMASI ve
    // BELLEK kopyasının her koşulda temizlenmesidir.
    redisAvailable = false;                       // kayıt belleğe yazılsın
    await setViolationRecord('4.4.4.4', { count: 2, firstAt: 1 });

    redisAvailable = true;
    redisClient = makeRedisClient({ failOn: 'del' });
    await expect(deleteViolationRecord('4.4.4.4')).resolves.toBeUndefined();

    redisAvailable = false;                       // bellek kopyasını oku
    expect(await getViolationRecord('4.4.4.4')).toBeNull();
  });

  it('BOZUK JSON kayıt istisna fırlatmaz', async () => {
    redisAvailable = true;
    const client = makeRedisClient();
    redisClient = client;
    client._kv.set('rl:violations:5.5.5.5', '{bozuk');
    await expect(getViolationRecord('5.5.5.5')).resolves.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('otomatik IP ban', () => {
  const THRESHOLD = 10;   // RL_HTTP_AUTO_BAN_THRESHOLD varsayılanı

  it('EŞİK aşılınca ban uygulanır', async () => {
    const app = buildApp(1, 60_000, 'ban-esigi');
    await hit(app, 1 + THRESHOLD);          // 1 başarılı + THRESHOLD ihlal

    expect(mockBanIp).toHaveBeenCalledTimes(1);
    // NOT: IP `lib/clientIp.ts` tarafindan cozulur (guvenilen proxy modeli),
    // `req.ip` atamasindan DEGIL — supertest'te bu loopback adresidir.
    const [ip, opts] = mockBanIp.mock.calls[0] as [string, Record<string, unknown>];
    expect(typeof ip).toBe('string');
    expect(ip.length).toBeGreaterThan(0);
    expect(opts.adminId).toBe('system');
    expect(String(opts.reason)).toContain('ban-esigi');
    expect(opts.durationMs).toBeGreaterThan(0);
    expect(mockTrackAutoBan).toHaveBeenCalled();
  });

  it('eşiğin ALTINDA ban UYGULANMAZ', async () => {
    const app = buildApp(1, 60_000, 'esik-alti');
    await hit(app, THRESHOLD - 2);
    expect(mockBanIp).not.toHaveBeenCalled();
  });

  it('ZATEN BANLI IP tekrar banlanmaz', async () => {
    // Tekrar ban, süreyi her ihlalde uzatarak fiilen kalıcı ban üretirdi.
    mockGetBan.mockResolvedValue({ ip: '10.1.2.3', reason: 'onceki' });
    const app = buildApp(1, 60_000, 'zaten-banli');
    await hit(app, 1 + THRESHOLD + 3);
    expect(mockBanIp).not.toHaveBeenCalled();
  });

  it('ban ALTYAPISI PATLASA BİLE istek 429 alır', async () => {
    // ── ÖNEMLİ ─────────────────────────────────────────────────────────────
    // Ban kodu `try/catch` içindedir. Oradaki bir hata 429'u yutsaydı,
    // limiter tam ters yönde çalışıp ihlalciyi KABUL ederdi.
    mockBanIp.mockRejectedValue(new Error('ban store down'));
    const app = buildApp(1, 60_000, 'ban-arizasi');
    const codes = await hit(app, 1 + THRESHOLD);
    expect(codes[0]).toBe(200);
    expect(codes.slice(1).every(c => c === 429)).toBe(true);
  });

  it('METRİK toplayıcı patlasa bile istek 429 alır', async () => {
    mockTrackHit.mockImplementation(() => { throw new Error('metrics down'); });
    const app = buildApp(1, 60_000, 'metrik-arizasi');
    expect(await hit(app, 2)).toEqual([200, 429]);
  });

  it('429 yanıtı Retry-After ve limit başlıklarını taşır', async () => {
    const app = buildApp(1, 60_000, 'basliklar');
    await request(app).get('/t');
    const r = await request(app).get('/t');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('60');
    expect(r.headers['x-ratelimit-remaining']).toBe('0');
    expect(r.body.retryAfter).toBe(60);
  });

  it('Redis ihlal sayacı non-Error ile çökerse yerel sayaç korumayı sürdürür', async () => {
    redisAvailable = true;
    redisClient = makeRedisClient();
    mockCacheIncrement.mockRejectedValue('counter connection closed');
    const app = buildApp(1, 60_000, 'counter-fallback');
    expect(await hit(app, 2)).toEqual([200, 429]);
  });

  it('opsiyonel metrik ve ban modülleri yokken kota yine 429 uygular', async () => {
    jest.resetModules();
    jest.doMock('../lib/_optional-require', () => ({ tryRequire: () => null }));
    redisAvailable = false;
    try {
      const isolated = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');
      const app = express();
      app.get('/t', isolated.rateLimit(1, 60_000, 'optional-modules-absent'), (_req: Request, res: Response) => res.json({ ok: true }));
      expect((await hit(app, 11)).slice(1).every(code => code === 429)).toBe(true);
      expect(mockBanIp).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('../lib/_optional-require');
      jest.resetModules();
    }
  });

  it('metrik yokken otomatik ban ve reddedilen sayaç temizliği güvenle tamamlanır', async () => {
    jest.resetModules();
    jest.doMock('../lib/_optional-require', () => ({
      tryRequire: (id: string) => id === './ipBan'
        ? { getBan: (...a: unknown[]) => mockGetBan(...a), banIp: (...a: unknown[]) => mockBanIp(...a) }
        : null,
    }));
    redisAvailable = false;
    mockCacheDel.mockRejectedValueOnce(new Error('cleanup unavailable'));
    try {
      const isolated = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');
      const app = express();
      app.get('/t', isolated.rateLimit(1, 60_000, 'metrics-absent'), (_req: Request, res: Response) => res.json({ ok: true }));
      const statuses = await hit(app, 11);
      expect(statuses[0]).toBe(200);
      expect(statuses.slice(1).every(code => code === 429)).toBe(true);
      expect(mockBanIp).toHaveBeenCalledTimes(1);
      expect(mockCacheDel).toHaveBeenCalled();
    } finally {
      jest.dontMock('../lib/_optional-require');
      jest.resetModules();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('per-user-ip modu', () => {
  it('kullanıcı VE user+IP anahtarlarının İKİSİ de sayılır', async () => {
    const app = buildApp(2, 60_000, 'uip', { mode: 'per-user-ip' }, 'ayse');
    const r = await request(app).get('/t');
    expect(r.headers['x-ratelimit-policy']).toContain('mode=per-user-ip');
    expect(r.headers['x-ratelimit-policy']).toContain('keys=2');
  });

  it('kimlik YOKSA tek IP anahtarına düşer', async () => {
    const app = buildApp(2, 60_000, 'uip-anon', { mode: 'per-user-ip' });
    const r = await request(app).get('/t');
    expect(r.headers['x-ratelimit-policy']).toContain('keys=1');
  });

  it('limit yine uygulanır', async () => {
    const app = buildApp(2, 60_000, 'uip-limit', { mode: 'per-user-ip' }, 'ayse');
    expect(await hit(app, 3)).toEqual([200, 200, 429]);
  });
});

describe('ip-only modu', () => {
  it('kimlik doğrulanmış olsa BİLE yalnızca IP sayılır', async () => {
    // Federation ping gibi uçlarda kota IP'ye aittir; kimliğe bakmak
    // tek bir eşin sınırsız istek atmasına izin verirdi.
    const app = buildApp(2, 60_000, 'ip-only', { mode: 'ip-only' }, 'ayse');
    const r = await request(app).get('/t');
    expect(r.status).toBe(200);
    expect(r.headers['x-ratelimit-policy']).toContain('mode=ip-only');
    expect(r.headers['x-ratelimit-policy']).toContain('keys=1');
    // Yukarida 1 istek harcandi; tavan 2 oldugundan sirasiyla 200 ve 429 beklenir.
    expect(await hit(app, 2)).toEqual([200, 429]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bellek deposu bakımı', () => {
  it('periyodik bakım eski ihlal kayıtlarını siler ve tazesini korur', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    jest.resetModules();
    redisAvailable = false;
    try {
      const isolated = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');
      await isolated.setViolationRecord('stale', { count: 2, firstAt: Date.now() - 3_600_001 });
      await isolated.setViolationRecord('fresh', { count: 1, firstAt: Date.now() });

      jest.advanceTimersByTime(10 * 60_000);

      await expect(isolated.getViolationRecord('stale')).resolves.toBeNull();
      await expect(isolated.getViolationRecord('fresh')).resolves.toEqual({ count: 1, firstAt: 1_000_000 });
    } finally {
      jest.useRealTimers();
      jest.resetModules();
    }
  });

  it('varsayılan boş anahtar öneki geçerli ve sınırlı bir kota üretir', async () => {
    const app = express();
    app.get('/t', rateLimit(1, 60_000), (_req: Request, res: Response) => res.json({ ok: true }));
    expect(await hit(app, 2)).toEqual([200, 429]);
  });

  it('budama tamamen eski kovayı siler', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const app = buildApp(2, 60_000, 'budama-eski');
      await hit(app, 1);
      now.mockReturnValue(1_000_000 + 300_001);
      pruneMemStore();
      expect(await hit(app, 3)).toEqual([200, 200, 429]);
    } finally {
      now.mockRestore();
    }
  });

  it('pruneMemStore ESKİ girdileri atar, tazeleri korur', async () => {
    const app = buildApp(5, 60_000, 'budama');
    await hit(app, 2);
    expect(() => pruneMemStore()).not.toThrow();
    // Taze girdiler korunduğu için sayaç sıfırlanmamalı.
    const r = await request(app).get('/t');
    expect(r.headers['x-ratelimit-remaining']).toBe('2');
  });

  it('budama sınır davranışını DEĞİŞTİRMEZ', async () => {
    const app = buildApp(2, 60_000, 'budama-sinir');
    await hit(app, 2);
    pruneMemStore();
    expect(await hit(app, 1)).toEqual([429]);
  });
});
