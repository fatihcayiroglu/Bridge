// server/tests/ratelimit-configured-redis-authority.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REDIS YAPILANDIRILMIŞKEN OTORİTE ZORUNLUDUR (fail-closed)
// ════════════════════════════════════════════════════════════════════════════
//
// `middleware/rateLimit.ts` iki farklı dünyada çalışır ve davranışı ZITTIR:
//
//   REDIS_URL YOK   → Redis hatası TOLERE edilir, süreç-yerel belleğe düşülür.
//   REDIS_URL VAR   → Redis hatası TOLERE EDİLEMEZ; çünkü çok düğümlü bir
//                     kurulumda süreç-yerel sayaca düşmek, sınırı düğüm sayısı
//                     kadar ÇARPAR. Yani "biraz bozuk" değil, sınır fiilen
//                     KALKMIŞ olur.
//
// `REDIS_CONFIGURED` modül yüklenirken `process.env.REDIS_URL`den okunur, bu
// yüzden bu dünyanın kendi test dosyası olmak ZORUNDADIR: mevcut
// `ratelimit-error-paths.test.ts` değişkeni SİLEREK yükler ve bu dalların
// hiçbirini çalıştıramaz. Ölçüldü: `getViolationRecord` /
// `setViolationRecord` / `deleteViolationRecord` / `incrementViolationCount`
// içindeki `if (REDIS_CONFIGURED) throw err` satırları hiç koşmuyordu.

process.env.NODE_ENV = 'test';
const previousRedisUrl = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://127.0.0.1:6379';

import request from 'supertest';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';

let redisAvailable = true;
let failMode: 'none' | 'get' | 'set' | 'del' | 'exec' = 'none';
const mockCacheIncrement = jest.fn();

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => redisAvailable,
  redisClient: () => ({}),
  redisAuthoritativeCommand: async (_op: string, command: (client: unknown) => Promise<unknown>) => {
    if (!redisAvailable) throw new Error('Redis authoritative command unavailable');
    return command({
      async get() { if (failMode === 'get') throw new Error('connection lost'); return null; },
      async set() { if (failMode === 'set') throw new Error('connection lost'); return 'OK'; },
      async del() { if (failMode === 'del') throw new Error('connection lost'); return 1; },
      multi() {
        const pipe = {
          zAdd() { return pipe; },
          zRemRangeByScore() { return pipe; },
          zCard() { return pipe; },
          expire() { return pipe; },
          async exec() {
            if (failMode === 'exec') throw new Error('READONLY replica');
            return [1, 0, 1, 1];
          },
        };
        return pipe;
      },
    });
  },
  cache: {
    get: jest.fn(), set: jest.fn(), setIfAbsent: jest.fn(), del: jest.fn(),
    increment: (...a: unknown[]) => mockCacheIncrement(...a),
  },
}));

jest.mock('../middleware/ipBan', () => ({ getBan: jest.fn(), banIp: jest.fn() }));
jest.mock('../middleware/metrics', () => ({
  trackRateLimitHit: jest.fn(), _bumpAnomalyCounter: jest.fn(), trackAutoBan: jest.fn(),
}));

const {
  rateLimit,
  getViolationRecord,
  setViolationRecord,
  deleteViolationRecord,
  _resetRateLimitStoreForTest,
} = require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');

function app(middleware: express.RequestHandler): Express {
  const server = express();
  server.set('trust proxy', true);
  server.get('/probe', middleware, (_req: Request, res: Response) => { res.json({ ok: true }); });
  return server;
}

beforeEach(() => {
  redisAvailable = true;
  failMode = 'none';
  mockCacheIncrement.mockReset().mockResolvedValue(1);
  _resetRateLimitStoreForTest();
});

afterAll(() => {
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('REDIS_URL yapılandırılmışken ihlal kayıtları belleğe SESSİZCE düşmez', () => {
  it('getViolationRecord Redis hatasını YUTMAZ', async () => {
    failMode = 'get';
    await expect(getViolationRecord('203.0.113.10')).rejects.toThrow(/connection lost/);
  });

  it('setViolationRecord Redis hatasını YUTMAZ', async () => {
    failMode = 'set';
    await expect(setViolationRecord('203.0.113.11', { count: 1, firstAt: Date.now() }))
      .rejects.toThrow(/connection lost/);
  });

  it('deleteViolationRecord Redis hatasını YUTMAZ', async () => {
    failMode = 'del';
    await expect(deleteViolationRecord('203.0.113.12')).rejects.toThrow(/connection lost/);
  });

  it('Redis erişilemezken de süreç-yerel belleğe düşmez', async () => {
    redisAvailable = false;
    await expect(getViolationRecord('203.0.113.13'))
      .rejects.toThrow(/Redis authoritative command unavailable/);
  });
});

describe('REDIS_URL yapılandırılmışken sayaç arızası isteği GEÇİRMEZ', () => {
  it('sliding-window sayımı patlarsa 503 ile fail-closed olunur', async () => {
    failMode = 'exec';
    const res = await request(app(rateLimit(5, 60_000, 'probe-exec', { mode: 'ip' }))).get('/probe');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    // En tehlikeli arıza biçimi: sayaç çalışmıyorken isteğin GEÇMESİ.
    expect(res.body.ok).toBeUndefined();
  });

  it('Redis tamamen erişilemezken de 503 döner, bellek sayacına düşmez', async () => {
    redisAvailable = false;
    const res = await request(app(rateLimit(1, 60_000, 'probe-down', { mode: 'ip' }))).get('/probe');
    expect(res.status).toBe(503);
  });

  it('sağlıklı Redis ile istek normal biçimde geçer', async () => {
    const res = await request(app(rateLimit(5, 60_000, 'probe-ok', { mode: 'ip' }))).get('/probe');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
  });
});
