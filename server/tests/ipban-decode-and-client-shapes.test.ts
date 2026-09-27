// server/tests/ipban-decode-and-client-shapes.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// IP YASAĞI — KALICI KAYIT ÇÖZÜMLEME VE İSTEMCİ YÜZEY FARKLARI
// ════════════════════════════════════════════════════════════════════════════
//
// IP yasağı bir ERİŞİM DENETİMİ sınırıdır ve iki yönde de sessiz kalamaz:
//
//   · BOZUK KAYIT = AÇIK KAPI DEĞİL — depodaki satır bozuksa (elle düzenleme,
//     kısmi göç, farklı sürüm) yasak "yok" sayılamaz. Ara katman 503 ile
//     fail-closed olur; sessizce `next()` demek yasağı kaldırırdı.
//   · ANAHTAR KARIŞMASI — kayıt, istendiği IP'ye ait olduğunu KENDİ içinde
//     taşır. Farklı bir IP'nin satırı okunursa reddedilir; aksi hâlde önbellek
//     zehirleme ile yanlış kişi engellenirdi.
//   · İSTEMCİ YÜZEYİ — node-redis (`setEx`/`mGet`) ile eski/test cephesi
//     (`set(..,{EX})`/`mget`) farklı imzalar taşır. Yanlış dal TTL'siz kalıcı
//     yasak ya da çöken bir liste üretirdi.

'use strict';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-32chars!!';

import type { NextFunction, Request, Response } from 'express';

type Store = Map<string, string>;

interface FakeRedis {
  status: string;
  store: Store;
  ttl: Map<string, number>;
  set: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
  keys: jest.Mock;
  setEx?: jest.Mock;
  mGet?: jest.Mock;
  mget?: jest.Mock;
}

function baseRedis(): FakeRedis {
  const store: Store = new Map();
  const ttl = new Map<string, number>();
  return {
    status: 'ready', store, ttl,
    set: jest.fn(async (k: string, v: string, opts?: { EX?: number }) => {
      store.set(k, v);
      if (opts?.EX) ttl.set(k, opts.EX);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => { const had = store.delete(k); ttl.delete(k); return had ? 1 : 0; }),
    keys: jest.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter(k => k.startsWith(prefix));
    }),
  };
}

/** node-redis yüzeyi: `setEx` + `mGet`. */
function modernRedis(): FakeRedis {
  const redis = baseRedis();
  redis.setEx = jest.fn(async (k: string, s: number, v: string) => { redis.store.set(k, v); redis.ttl.set(k, s); return 'OK'; });
  redis.mGet = jest.fn(async (keys: string[]) => keys.map(k => redis.store.get(k) ?? null));
  return redis;
}

/** Eski/test cephesi: yalnız `set(.., { EX })` + `mget(...keys)`. */
function legacyRedis(): FakeRedis {
  const redis = baseRedis();
  redis.mget = jest.fn(async (...keys: string[]) => keys.map(k => redis.store.get(k) ?? null));
  return redis;
}

/** Çoklu okuma yeteneği HİÇ olmayan cephe. */
function multiGetlessRedis(): FakeRedis {
  return baseRedis();
}

async function fresh(redis?: FakeRedis) {
  jest.resetModules();
  const g = global as typeof globalThis & { _bridgeRedis?: FakeRedis };
  delete g._bridgeRedis;
  if (redis) g._bridgeRedis = redis;
  return await import('../middleware/ipBan');
}

const KEY = (ip: string) => `bridge:ipban:${ip}`;
const IP = '203.0.113.55';

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ip: IP, reason: 'Admin ban', bannedAt: 1_000, expiresAt: null, adminId: null, ...over };
}

function res() {
  const captured: { status?: number; body?: unknown } = {};
  const r = {
    status(code: number) { captured.status = code; return r; },
    json(body: unknown) { captured.body = body; return r; },
  };
  return { captured, res: r as unknown as Response };
}

const req = (path = '/api/messages', ip = IP): Request =>
  ({ path, headers: {}, ip, socket: { remoteAddress: ip } }) as unknown as Request;

describe('kalıcı kayıt çözümleme', () => {
  const malformed: Array<[string, unknown]> = [
    ['nesne olmayan', '"düz metin"'],
    ['null', 'null'],
    ['ip alanı yok', JSON.stringify({ reason: 'x', bannedAt: 1, expiresAt: null, adminId: null })],
    ['ip boş', JSON.stringify(entry({ ip: '' }))],
    ['reason metin değil', JSON.stringify(entry({ reason: 42 }))],
    ['bannedAt güvenli tamsayı değil', JSON.stringify(entry({ bannedAt: 1.5 }))],
    ['bannedAt negatif', JSON.stringify(entry({ bannedAt: -1 }))],
    ['expiresAt geçersiz', JSON.stringify(entry({ expiresAt: 'yarın' }))],
    ['adminId geçersiz', JSON.stringify(entry({ adminId: 7 }))],
  ];

  it.each(malformed)('bozuk kayıt (%s) yasağı kaldırmaz, fail-closed olunur', async (_label, raw) => {
    const redis = modernRedis();
    redis.store.set(KEY(IP), String(raw));
    const mod = await fresh(redis);

    await expect(mod.getBan(IP)).rejects.toThrow(/Invalid persisted IP ban/);

    const { captured, res: response } = res();
    const next = jest.fn();
    await mod.ipBanMiddleware(req(), response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(503);
    expect(captured.body).toEqual({ error: 'IP erişim denetimi geçici olarak kullanılamıyor' });
  });

  it('başka bir IP\'ye ait kayıt bu IP için kabul edilmez', async () => {
    const redis = modernRedis();
    redis.store.set(KEY(IP), JSON.stringify(entry({ ip: '198.51.100.9' })));
    const mod = await fresh(redis);

    await expect(mod.getBan(IP)).rejects.toThrow(/Invalid persisted IP ban/);
  });

  it('geçerli kayıt okunur ve süresi dolmuşsa depodan silinir', async () => {
    const redis = modernRedis();
    const mod = await fresh(redis);

    await mod.banIp(IP, { reason: 'Spam', durationMs: 60_000, adminId: 'admin-1' });
    expect(await mod.getBan(IP)).toMatchObject({ ip: IP, reason: 'Spam', adminId: 'admin-1' });

    redis.store.set(KEY(IP), JSON.stringify(entry({ expiresAt: Date.now() - 1 })));
    expect(await mod.getBan(IP)).toBeNull();
    expect(redis.store.has(KEY(IP))).toBe(false);
  });
});

describe('istemci yüzey farkları', () => {
  it('node-redis cephesi TTL\'i tek komutta yazar', async () => {
    const redis = modernRedis();
    const mod = await fresh(redis);

    await mod.banIp(IP, { durationMs: 30_000 });

    expect(redis.setEx).toHaveBeenCalledWith(KEY(IP), 30, expect.any(String));
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.ttl.get(KEY(IP))).toBe(30);
  });

  it('eski cephe TTL\'i `set` seçenekleriyle yazar', async () => {
    const redis = legacyRedis();
    const mod = await fresh(redis);

    await mod.banIp(IP, { durationMs: 45_000 });

    expect(redis.set).toHaveBeenCalledWith(KEY(IP), expect.any(String), { EX: 45 });
    expect(redis.ttl.get(KEY(IP))).toBe(45);
  });

  it('süresiz yasak TTL olmadan yazılır', async () => {
    const redis = modernRedis();
    const mod = await fresh(redis);

    await mod.banIp(IP);

    expect(redis.setEx).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(KEY(IP), expect.any(String));
    expect(await mod.getBan(IP)).toMatchObject({ expiresAt: null });
  });

  it('liste her iki çoklu-okuma imzasını da kullanır ve süresi dolanları eler', async () => {
    for (const make of [modernRedis, legacyRedis]) {
      const redis = make();
      const mod = await fresh(redis);
      await mod.banIp('203.0.113.1', { reason: 'A' });
      await mod.banIp('203.0.113.2', { reason: 'B', durationMs: 60_000 });
      redis.store.set(KEY('203.0.113.3'), JSON.stringify(entry({ ip: '203.0.113.3', expiresAt: Date.now() - 1 })));

      const bans = await mod.listBans();

      expect(bans.map(b => b.ip).sort()).toEqual(['203.0.113.1', '203.0.113.2']);
    }
  });

  it('hiç yasak yokken liste depoya ikinci kez gitmez', async () => {
    const redis = modernRedis();
    const mod = await fresh(redis);

    expect(await mod.listBans()).toEqual([]);
    expect(redis.mGet).not.toHaveBeenCalled();
  });

  it('çoklu okuma desteklemeyen istemci sessiz boş liste vermez', async () => {
    const redis = multiGetlessRedis();
    const mod = await fresh(redis);
    await mod.banIp(IP);

    await expect(mod.listBans()).rejects.toThrow(/multi-get/);
  });
});

describe('süreç-yerel yedek', () => {
  it('Redis yokken yasak bellekte tutulur, süresi dolunca listeden düşer', async () => {
    const mod = await fresh();

    await mod.banIp('203.0.113.7', { reason: 'Bellek', durationMs: 60_000 });
    expect(await mod.getBan('203.0.113.7')).toMatchObject({ reason: 'Bellek' });
    expect((await mod.listBans()).map(b => b.ip)).toEqual(['203.0.113.7']);

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    expect(await mod.getBan('203.0.113.7')).toBeNull();
    expect(await mod.listBans()).toEqual([]);
    jest.restoreAllMocks();
  });

  it('yasak kaldırma bellekten de siler', async () => {
    const mod = await fresh();
    await mod.banIp(IP);

    await mod.unbanIp(IP);

    expect(await mod.getBan(IP)).toBeNull();
  });

  it('geçersiz IP ile yasak yazılamaz', async () => {
    const mod = await fresh();

    await expect(mod.banIp('')).rejects.toThrow('Geçersiz IP');
    await expect(mod.banIp('unknown')).rejects.toThrow('Geçersiz IP');
  });
});

describe('ara katman kararları', () => {
  it('yasaksız istek geçirilir', async () => {
    const mod = await fresh();
    const { captured, res: response } = res();
    const next = jest.fn();

    await mod.ipBanMiddleware(req(), response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(captured.status).toBeUndefined();
  });

  it('süreli yasak kalan saniyeyi bildirir, süresiz yasak bildirmez', async () => {
    const mod = await fresh();

    await mod.banIp('127.0.0.1', { reason: 'Spam', durationMs: 60_000 });
    const timed = res();
    await mod.ipBanMiddleware(req('/api/x', '127.0.0.1'), timed.res, jest.fn() as unknown as NextFunction);
    expect(timed.captured.status).toBe(403);
    expect(timed.captured.body).toMatchObject({ reason: 'Spam' });
    expect((timed.captured.body as { remainingSeconds: number }).remainingSeconds).toBeGreaterThan(0);

    await mod.unbanIp('127.0.0.1');
    await mod.banIp('127.0.0.1', { reason: 'Kalıcı' });
    const permanent = res();
    await mod.ipBanMiddleware(req('/api/x', '127.0.0.1'), permanent.res, jest.fn() as unknown as NextFunction);
    expect(permanent.captured.body).not.toHaveProperty('remainingSeconds');
  });
});
