// server/tests/ratelimit-shared-authority-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REDIS OTORİTESİ ÇALIŞIRKEN VE İHLAL SAYACI ÇÖKERKEN DAVRANIŞ
// ════════════════════════════════════════════════════════════════════════════
//
// `ratelimit-configured-redis-authority.test.ts` Redis'in ÇÖKTÜĞÜ dünyayı
// ölçer. Ölçülmeyen iki ayrı yol daha var ve ikisi de üretimde asıl çalışan
// yollardır:
//
//   1. SAYAÇ GERÇEKTEN REDIS'TEN GELİYOR — `combined` modda önce HESAP, sonra
//      IP sayacı okunur. İkisi de Redis'ten döndüğünde süreç-yerel yedeğe
//      DÜŞÜLMEMELİDİR; düşülseydi çok düğümlü kurulumda sınır düğüm sayısı
//      kadar çarpılırdı ve bunu hiçbir test yakalamıyordu.
//
//   2. İHLAL SAYACI ÇÖKÜYOR — 429 anında paylaşılan ihlal sayacı okunamazsa
//      istek yine de REDDEDİLMELİDİR. Sayaç arızası bir "geçiş izni" değildir.
//      Ayrıca fırlatılan değer bir `Error` olmayabilir (ör. bir sürücü düz
//      string atar); log satırı bu durumda da çökmemelidir.

process.env.NODE_ENV = 'test';
const previousRedisUrl = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://127.0.0.1:6379';

import { makeJwtUser } from './helpers/userDoubles';
import request from 'supertest';
import express from 'express';
import type { Express, Request, RequestHandler, Response, NextFunction } from 'express';

let redisAvailable = true;
let zCardCount = 1;
const mockCacheIncrement = jest.fn();
const mockCacheDel = jest.fn();
const banIp = jest.fn();
const getBan = jest.fn();
const loggedErrors: unknown[] = [];

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => redisAvailable,
  redisClient: () => ({}),
  redisAuthoritativeCommand: async (_op: string, command: (client: unknown) => Promise<unknown>) => {
    if (!redisAvailable) throw new Error('Redis authoritative command unavailable');
    return command({
      async get() { return null; },
      async set() { return 'OK'; },
      async del() { return 1; },
      multi() {
        const pipe = {
          zAdd() { return pipe; },
          zRemRangeByScore() { return pipe; },
          zCard() { return pipe; },
          expire() { return pipe; },
          async exec() { return [1, 0, zCardCount, 1]; },
        };
        return pipe;
      },
    });
  },
  cache: {
    get: jest.fn(), set: jest.fn(), setIfAbsent: jest.fn(),
    del: (...a: unknown[]) => mockCacheDel(...a),
    increment: (...a: unknown[]) => mockCacheIncrement(...a),
  },
}));

jest.mock('../middleware/ipBan', () => ({ getBan: (...a: unknown[]) => getBan(...a), banIp: (...a: unknown[]) => banIp(...a) }));
jest.mock('../middleware/metrics', () => ({
  trackRateLimitHit: jest.fn(), _bumpAnomalyCounter: jest.fn(), trackAutoBan: jest.fn(),
}));
jest.mock('../lib/logger', () => {
  const record = (payload: unknown) => { loggedErrors.push(payload); };
  const logger = {
    error: (payload: unknown) => record(payload),
    warn: (payload: unknown) => record(payload),
    info: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn(),
    child: () => logger,
  };
  return { __esModule: true, default: logger, createLogger: () => logger, logger };
});

const { rateLimit, _resetRateLimitStoreForTest } =
  require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');

/** Kanonik cozumleyici (lib/clientIp) test kosumunda dogrudan soket IP'sini verir. */
const LOOPBACK = '127.0.0.1';

const AUTHED: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  req.user = makeJwtUser('kullanici-1');
  next();
};

function app(middleware: RequestHandler, authed = true): Express {
  const server = express();
  server.set('trust proxy', true);
  const chain = authed ? [AUTHED, middleware] : [middleware];
  server.get('/probe', ...chain, (_req: Request, res: Response) => { res.json({ ok: true }); });
  return server;
}

beforeEach(() => {
  redisAvailable = true;
  zCardCount = 1;
  loggedErrors.length = 0;
  mockCacheIncrement.mockReset().mockResolvedValue(1);
  mockCacheDel.mockReset().mockResolvedValue(undefined);
  banIp.mockReset().mockResolvedValue(undefined);
  getBan.mockReset().mockResolvedValue(null);
  _resetRateLimitStoreForTest();
});

afterAll(() => {
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('paylaşılan sayaç çalışırken combined mod', () => {
  it('hem hesap hem IP sayacı Redis\'ten okunur; süreç-yerel yedeğe düşülmez', async () => {
    zCardCount = 3;
    const res = await request(app(rateLimit(10, 60_000, 'combined-ok', { mode: 'combined' })))
      .get('/probe');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Baslıklar KULLANICI kotasını yansıtır; IP anahtarı acil durum tavanıdır.
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('7');
    expect(res.headers['x-ratelimit-policy']).toContain('mode=combined;keys=2');
  });

  it('aynı istek arka arkaya geldiğinde sayaç Redis\'ten geldiği için ARTMAZ (yerel sayaç devreye girmez)', async () => {
    zCardCount = 4;
    const server = app(rateLimit(10, 60_000, 'combined-stable', { mode: 'combined' }));

    const first = await request(server).get('/probe');
    const second = await request(server).get('/probe');

    // Süreç-yerel yedek devreye girseydi ikinci istekte kalan 1 azalırdı.
    expect(first.headers['x-ratelimit-remaining']).toBe('6');
    expect(second.headers['x-ratelimit-remaining']).toBe('6');
  });

  it('hesap kendi kotasını aşarsa IP bütçesi harcanmadan reddedilir', async () => {
    zCardCount = 11;
    const res = await request(app(rateLimit(10, 60_000, 'combined-account', { mode: 'combined' })))
      .get('/probe');

    expect(res.status).toBe(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body.ok).toBeUndefined();
  });
});

describe('ihlal sayacı çökerken 429 kararı korunur', () => {
  it('paylaşılan sayaç Error olmayan bir değer fırlatsa bile istek GEÇMEZ', async () => {
    zCardCount = 9;
    // Bazı sürücüler düz string atar; log satırı `err.message` okumaya
    // kalkarsa `undefined` yazar, `String(err)` ile anlamlı kalır.
    mockCacheIncrement.mockRejectedValue('redis stream closed');

    const res = await request(app(rateLimit(1, 60_000, 'violation-nonerror', { mode: 'ip' }), false))
      .get('/probe');

    expect(res.status).toBe(429);
    expect(res.body.ok).toBeUndefined();
    expect(res.body.retryAfter).toBe(60);
    // Sayaç okunamadığı için otomatik ban ESKALASYONU yapılmaz.
    expect(banIp).not.toHaveBeenCalled();
    expect(mockCacheDel).not.toHaveBeenCalled();
    // Arıza sessizce yutulmaz: operatör için tek bir hata kaydı bırakılır.
    expect(loggedErrors.some(entry => JSON.stringify(entry).includes('ratelimit.auto_ban.failed'))).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('redis stream closed');
  });

  it('paylaşılan sayaç Error fırlattığında da aynı fail-closed sonuç verilir', async () => {
    zCardCount = 9;
    mockCacheIncrement.mockRejectedValue(new Error('READONLY replica'));

    const res = await request(app(rateLimit(1, 60_000, 'violation-error', { mode: 'ip' }), false))
      .get('/probe');

    expect(res.status).toBe(429);
    expect(banIp).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('READONLY');
  });

  it('sayaç çalışırken eşik aşılırsa otomatik ban uygulanır (kontrol grubu)', async () => {
    zCardCount = 9;
    mockCacheIncrement.mockResolvedValue(10);

    const res = await request(app(rateLimit(1, 60_000, 'violation-ban', { mode: 'ip' }), false))
      .get('/probe');

    expect(res.status).toBe(429);
    expect(banIp).toHaveBeenCalledWith(LOOPBACK, expect.objectContaining({ adminId: 'system', durationMs: 600_000 }));
    expect(mockCacheDel).toHaveBeenCalledWith(`httpviolation:${LOOPBACK}`);
  });
});
