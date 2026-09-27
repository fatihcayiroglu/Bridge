// server/tests/redis-adapter-default-arguments.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÖNBELLEK ADAPTÖRÜ — BELGELENMİŞ VARSAYILANLAR VE SEYREK OKUMA KENARLARI
// ════════════════════════════════════════════════════════════════════════════
//
// Bu adaptörün her yazma ucu bir VARSAYILAN TTL belgeler (`set`/`mset` 300 sn,
// `increment` 60 sn) ve hız sınırlayıcı da varsayılan kota taşır. Çağrı
// yerlerinin çoğu bu varsayılanlara güvenir; yanlış bir varsayılan iki farklı
// üretim arızası verir:
//
//   · SÜRESİZ KALAN GİRİŞ — TTL kaybolursa bellekteki (ya da Redis'teki)
//     giriş asla düşmez; bayat oturum/izin verisi kalıcılaşır.
//   · SÜRESİZ SAYAÇ — `increment` TTL'siz kalırsa hız sınırı sayacı hiç
//     sıfırlanmaz ve meşru kullanıcı KALICI olarak kilitlenir.
//
// Ayrıca hash okuma yolunun seyrek/bozuk kayıt kenarları ölçülür: alanı
// olmayan hash, dizi olarak yazılmış bozuk kayıt ve hiç var olmayan anahtar.

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;
process.env.MEM_CACHE_MAX_ENTRIES = '20';
process.env.MEM_CACHE_SWEEP_MS = '60000';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const redis = require('../lib/redisAdapter') as typeof import('../lib/redisAdapter');
const { cache, redisRateLimiter } = redis;

const NS = 'defaults:';

function res() {
  const captured: { status?: number; body?: unknown; headers: Record<string, unknown> } = { headers: {} };
  const r = {
    setHeader(name: string, value: unknown) { captured.headers[name] = value; },
    status(code: number) { captured.status = code; return { json(body: unknown) { captured.body = body; } }; },
  };
  return { captured, res: r };
}

beforeEach(async () => {
  await cache.invalidatePattern(NS);
  await cache.invalidatePattern(`hash:${NS}`);
  await cache.invalidatePattern('rate-fallback:');
});

afterAll(async () => { await redis.disconnect(); });

describe('belgelenmiş varsayılan TTL değerleri', () => {
  it('`set` varsayılanı girişi süresiz bırakmaz', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    await cache.set(`${NS}ttl`, { ok: true });
    expect(await cache.get(`${NS}ttl`)).toEqual({ ok: true });

    // Varsayilan 300 sn: hemen oncesinde YASAR, sonrasinda DUSER.
    clock.mockReturnValue(now + 299_000);
    expect(await cache.get(`${NS}ttl`)).toEqual({ ok: true });
    clock.mockReturnValue(now + 301_000);
    expect(await cache.get(`${NS}ttl`)).toBeNull();

    clock.mockRestore();
  });

  it('`setIfAbsent` varsayılan TTL ile yazar ve mevcut girişi ezmez', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    expect(await cache.setIfAbsent(`${NS}nx`, 'ilk')).toBe(true);
    expect(await cache.setIfAbsent(`${NS}nx`, 'ikinci')).toBe(false);
    expect(await cache.get(`${NS}nx`)).toBe('ilk');

    clock.mockReturnValue(now + 301_000);
    // Suresi dolan giris yeniden talep edilebilir.
    expect(await cache.setIfAbsent(`${NS}nx`, 'ucuncu')).toBe(true);
    expect(await cache.get(`${NS}nx`)).toBe('ucuncu');

    clock.mockRestore();
  });

  it('`setIfAbsent` sıfır TTL ile süresiz giriş yazar', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    expect(await cache.setIfAbsent(`${NS}kalici`, 'deger', 0)).toBe(true);
    clock.mockReturnValue(now + 10 * 86_400_000);
    expect(await cache.get(`${NS}kalici`)).toBe('deger');
    // Suresiz giris hâlâ NX korumasi altindadir.
    expect(await cache.setIfAbsent(`${NS}kalici`, 'baska', 0)).toBe(false);

    clock.mockRestore();
  });

  it('otoriter yazma uçları tek düğüm modunda aynı varsayılanı kullanır', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    await cache.setAuthoritative(`${NS}auth`, 'deger');
    expect(await cache.getAuthoritative(`${NS}auth`)).toBe('deger');
    expect(await cache.setIfAbsentAuthoritative(`${NS}auth-nx`, 1)).toBe(true);
    expect(await cache.setIfAbsentAuthoritative(`${NS}auth-nx`, 2)).toBe(false);

    clock.mockReturnValue(now + 301_000);
    expect(await cache.getAuthoritative(`${NS}auth`)).toBeNull();
    expect(await cache.setIfAbsentAuthoritative(`${NS}auth-nx`, 3)).toBe(true);

    clock.mockRestore();
  });

  it('`mset` varsayılanı da süreli yazar ve boş liste depoya dokunmaz', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    await cache.mset([]);
    await cache.mset([[`${NS}m1`, 1], [`${NS}m2`, 2]]);
    expect([...(await cache.mget([`${NS}m1`, `${NS}m2`])).values()]).toEqual([1, 2]);

    clock.mockReturnValue(now + 301_000);
    expect((await cache.mget([`${NS}m1`, `${NS}m2`])).size).toBe(0);

    clock.mockRestore();
  });

  it('`increment` varsayılan penceresi sayacı süresiz bırakmaz', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    expect(await cache.increment(`${NS}sayac`)).toBe(1);
    expect(await cache.increment(`${NS}sayac`)).toBe(2);

    // Varsayilan 60 sn sonra sayac sifirlanir: kullanici KALICI kilitlenmez.
    clock.mockReturnValue(now + 61_000);
    expect(await cache.increment(`${NS}sayac`)).toBe(1);

    clock.mockRestore();
  });

  it('`slidingWindowCount` varsayılan zamanı şimdiki zamandır ve tek düğümde null döner', async () => {
    expect(await cache.slidingWindowCount(`${NS}pencere`, 60_000)).toBeNull();
    await expect(cache.slidingWindowCount(`${NS}pencere`, 0)).rejects.toThrow(RangeError);
    await expect(cache.slidingWindowCount(`${NS}pencere`, 60_000, -1)).rejects.toThrow(RangeError);
  });
});

describe('hash okuma kenarları', () => {
  it('olmayan hash, olmayan alan ve bozuk kayıt güvenle boş döner', async () => {
    expect(await cache.hget(`${NS}yok`, 'alan')).toBeNull();
    expect(await cache.hgetAll(`${NS}yok`)).toEqual({});

    await cache.hset(`${NS}h`, 'var', { v: 1 });
    expect(await cache.hget(`${NS}h`, 'yok')).toBeNull();
    expect(await cache.hget(`${NS}h`, 'var')).toEqual({ v: 1 });

    // Dizi olarak yazilmis bozuk kayit hash sayilmaz.
    await cache.set(`hash:${NS}bozuk`, ['dizi'], 60);
    expect(await cache.hget(`${NS}bozuk`, 'alan')).toBeNull();
    expect(await cache.hgetAll(`${NS}bozuk`)).toEqual({});
  });

  it('hash anlık görüntüsü döner; dönen nesne değiştirildiğinde depo bozulmaz', async () => {
    await cache.hset(`${NS}snap`, 'a', 1);
    const snapshot = await cache.hgetAll<number>(`${NS}snap`);
    snapshot.a = 999;

    expect(await cache.hget(`${NS}snap`, 'a')).toBe(1);
  });

  it('alan silme yalnız o alanı düşürür', async () => {
    await cache.hset(`${NS}del`, 'a', 1);
    await cache.hset(`${NS}del`, 'b', 2);

    await cache.hdel(`${NS}del`, 'a');

    expect(await cache.hget(`${NS}del`, 'a')).toBeNull();
    expect(await cache.hget(`${NS}del`, 'b')).toBe(2);
  });
});

describe('varsayılan hız sınırlayıcı', () => {
  it('argümansız kurulum belgelenmiş kotayı uygular', async () => {
    const limiter = redisRateLimiter();
    const request = { ip: '203.0.113.200' } as never;

    const first = res();
    const next = jest.fn();
    await limiter(request, first.res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(first.captured.headers['X-RateLimit-Limit']).toBe(60);
    expect(first.captured.headers['X-RateLimit-Remaining']).toBe(59);
  });

  it('varsayılan kota aşıldığında 429 ve yeniden deneme süresi verilir', async () => {
    const limiter = redisRateLimiter({ max: 2, windowMs: 60_000, keyPrefix: 'defaults-rl' });
    const request = { ip: '203.0.113.201' } as never;

    for (let i = 0; i < 2; i += 1) {
      const ok = res();
      const next = jest.fn();
      await limiter(request, ok.res as never, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    const blocked = res();
    const blockedNext = jest.fn();
    await limiter(request, blocked.res as never, blockedNext);

    expect(blockedNext).not.toHaveBeenCalled();
    expect(blocked.captured.status).toBe(429);
    expect(blocked.captured.body).toEqual({ error: 'Too many requests', retryAfter: 60 });
    expect(blocked.captured.headers['Retry-After']).toBe(60);
  });

  it('geçersiz yapılandırma fail-open bir sınırlayıcı üretmez', () => {
    expect(() => redisRateLimiter({ windowMs: 999 })).toThrow(RangeError);
    expect(() => redisRateLimiter({ windowMs: 1.5 })).toThrow(RangeError);
    expect(() => redisRateLimiter({ max: 0 })).toThrow(RangeError);
    expect(() => redisRateLimiter({ max: -3 })).toThrow(RangeError);
  });

  it('kimliği olmayan istek anonim kovaya düşer', async () => {
    const limiter = redisRateLimiter({ max: 1, windowMs: 60_000, keyPrefix: 'defaults-anon' });

    const first = res();
    const firstNext = jest.fn();
    await limiter({} as never, first.res as never, firstNext);
    expect(firstNext).toHaveBeenCalledTimes(1);

    const second = res();
    const secondNext = jest.fn();
    await limiter({} as never, second.res as never, secondNext);
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.captured.status).toBe(429);
  });
});

describe('bellek içi önbellek sınırı', () => {
  it('tavan aşıldığında en eski girişler atılır ve yenileri korunur', async () => {
    for (let i = 0; i < 30; i += 1) await cache.set(`${NS}kova-${i}`, i, 300);

    // MEM_CACHE_MAX_ENTRIES=20: ilk yazilanlar dusmus, son yazilanlar durmali.
    expect(await cache.get(`${NS}kova-0`)).toBeNull();
    expect(await cache.get(`${NS}kova-29`)).toBe(29);
  });

  it('var olan anahtarın yeniden yazılması ekleme sırasını tazeler', async () => {
    for (let i = 0; i < 15; i += 1) await cache.set(`${NS}sira-${i}`, i, 300);
    await cache.set(`${NS}sira-0`, 'yenilendi', 300);
    for (let i = 15; i < 25; i += 1) await cache.set(`${NS}sira-${i}`, i, 300);

    // Tazelenen giris hayatta kalir; ondan sonraki eski girisler duser.
    expect(await cache.get(`${NS}sira-0`)).toBe('yenilendi');
    expect(await cache.get(`${NS}sira-1`)).toBeNull();
  });
});

describe('sağlık raporu', () => {
  it('tek düğüm modunda bellek kipini ve boyutu bildirir', async () => {
    await cache.set(`${NS}saglik`, 1, 60);

    const health = await redis.healthCheck();

    expect(health.redis).toBe(false);
    expect(health.mode).toBe('in-memory');
    expect(typeof health.memCacheSize).toBe('number');
    expect(health.url).toBeUndefined();
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
