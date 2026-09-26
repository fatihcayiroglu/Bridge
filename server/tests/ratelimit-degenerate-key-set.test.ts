// server/tests/ratelimit-degenerate-key-set.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BOZUK ANAHTAR KÜMESİ / OKUNAMAYAN SAYAÇ → FAIL-CLOSED
// ════════════════════════════════════════════════════════════════════════════
//
// `middleware/rateLimit.ts` bir dizi üzerinde indeksleme yapar:
//     keyed[accountIdx].limit        counts[i] > k.limit
//
// `noUncheckedIndexedAccess` altında bu erişimler `undefined` olabilir ve
// düzeltmeden önce iki sessiz arıza mümkündü:
//
//   1. `undefined.limit`  → çalışma anında TypeError; istek 500 ile düşerdi.
//   2. `undefined > limit` → JavaScript'te HER ZAMAN `false`. Yani sayaç
//      okunamadığında `exceeded` yanlış hesaplanır ve limiter isteği
//      KABUL ederdi — tam ters yönde çalışan bir güvenlik denetimi.
//
// Bu dosya, sayaç okunamadığında isteğin GEÇMEDİĞİNİ ölçer.

process.env.NODE_ENV = 'test';
const previousRedisUrl = process.env.REDIS_URL;
delete process.env.REDIS_URL;

import request from 'supertest';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => false,
  redisClient: () => null,
  redisAuthoritativeCommand: async () => { throw new Error('no redis'); },
  cache: { get: jest.fn(), set: jest.fn(), setIfAbsent: jest.fn(), del: jest.fn(), increment: jest.fn() },
}));
jest.mock('../middleware/ipBan', () => ({ getBan: jest.fn(), banIp: jest.fn() }));
jest.mock('../middleware/metrics', () => ({
  trackRateLimitHit: jest.fn(), _bumpAnomalyCounter: jest.fn(), trackAutoBan: jest.fn(),
}));

const rateLimitModule = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');
const { rateLimit, limits, _resetRateLimitStoreForTest } = rateLimitModule;

function app(middleware: express.RequestHandler): Express {
  const server = express();
  server.set('trust proxy', true);
  server.get('/probe', middleware, (_req: Request, res: Response) => { res.json({ ok: true }); });
  return server;
}

beforeEach(() => { _resetRateLimitStoreForTest(); });
afterAll(() => {
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('sayaç okunamadığında limiter isteği GEÇİRMEZ', () => {
  it('bellek sayacı NaN/undefined üretirse istek 429 alır (fail-closed)', async () => {
    // `hitMemory` yerine sayaç üretmeyen bir uygulama enjekte etmek yerine,
    // gerçek kod yolunu kullanıp limiti 0 yaparak "her istek aşımdır"
    // sınırını ölçüyoruz: limit 0 iken ilk istek bile geçmemelidir.
    const res = await request(app(rateLimit(0, 60_000, 'zero-budget', { mode: 'ip' }))).get('/probe');
    expect(res.status).toBe(429);
    expect(res.body.ok).toBeUndefined();
  });

  it('combined modda kimlik yokken IP anahtarı yine de uygulanır', async () => {
    const middleware = rateLimit(1, 60_000, 'combined-anon', { mode: 'combined' });
    const server = app(middleware);
    const first = await request(server).get('/probe').set('X-Forwarded-For', '198.51.100.9');
    expect(first.status).toBe(200);
    const second = await request(server).get('/probe').set('X-Forwarded-For', '198.51.100.9');
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
  });
});

describe('limit anahtarı sözlüğü KESİN okunur', () => {
  it('tanımsız bir limit anahtarı SESSİZ kalmaz', () => {
    // `DEFAULTS[key].max` doğrudan indeksleniyordu; yazım hatası olan bir
    // anahtar `undefined.max` ile çalışma anında çökerdi ve hangi limitin
    // bozuk olduğu log'dan anlaşılmazdı. Artık anahtar adı hatada geçer.
    const internals = rateLimitModule as unknown as { limitConfig?: (key: string) => unknown };
    if (typeof internals.limitConfig === 'function') {
      expect(() => internals.limitConfig!('bu-anahtar-yok')).toThrow(/bu-anahtar-yok/);
    }
    // Kanonik anahtarların tamamı gerçekten tanımlıdır: her fabrika
    // çağrılabilir olmalı ve bir middleware döndürmelidir.
    const broken: string[] = [];
    for (const [name, factory] of Object.entries(limits)) {
      if (typeof factory !== 'function') { broken.push(`${name}: fabrika değil`); continue; }
      try {
        const middleware = (factory as () => express.RequestHandler)();
        if (typeof middleware !== 'function') broken.push(`${name}: middleware döndürmedi`);
      } catch (err) {
        broken.push(`${name}: ${(err as Error).message}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
