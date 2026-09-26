// server/tests/ratelimit-memstore-bound.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ANAHTAR UZAYI TAŞKINI SÜREÇ BELLEĞİNİ SINIRSIZ BÜYÜTEMEZ
// ════════════════════════════════════════════════════════════════════════════
//
// Redis yokken hız sınırı sayaçları süreç-yerel bir `Map` içinde tutulur.
// Anahtar, isteği yapan kimliğe göre üretildiği için ANAHTAR SAYISI saldırgan
// kontrolündedir: dönen IP'ler ya da üretilen hesap kimlikleriyle sınırsız
// sayıda giriş yaratılabilir. Bu, hız sınırının kendisini bir bellek tüketme
// vektörüne çevirir.
//
// `hitMemory` bu yüzden tavan aşıldığında süpürgeyi çağırır. Süpürgenin iki
// ayrı yükümlülüğü vardır ve ikisi de burada ölçülür:
//
//   · tavan aşıldığında GERÇEKTEN çalışması,
//   · çalışırken CANLI sayaçları düşürmemesi. Süpürge canlı bir sayacı
//     silseydi hız sınırı sessizce SIFIRLANIR, yani fiilen kalkardı — bu,
//     "biraz bozuk" değil, korumanın tamamen kaybı olurdu.

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

import type { Request, Response, NextFunction } from 'express';

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => false,
  redisClient: () => null,
  redisAuthoritativeCommand: async () => { throw new Error('kullanilmamali'); },
  cache: { get: jest.fn(), set: jest.fn(), setIfAbsent: jest.fn(), del: jest.fn(), increment: jest.fn() },
}));
jest.mock('../middleware/ipBan', () => ({ getBan: jest.fn(), banIp: jest.fn() }));
jest.mock('../middleware/metrics', () => ({
  trackRateLimitHit: jest.fn(), _bumpAnomalyCounter: jest.fn(), trackAutoBan: jest.fn(),
}));

const { rateLimit, pruneMemStore, _resetRateLimitStoreForTest } =
  require('../middleware/rateLimit') as typeof import('../middleware/rateLimit');

// `hitMemory` icindeki tavan; asilinca supurge devreye girer.
const MAX_STORE_SIZE = 100_000;

interface Probe { status: number; headers: Record<string, string>; passed: boolean }

/**
 * Ara katmanı doğrudan sürer. Express/supertest yığını 100_000 istekte
 * ölçümü saniyelere değil dakikalara taşırdı; ölçülen şey sayaç deposudur.
 */
function drive(middleware: ReturnType<typeof rateLimit>, userId: string): Promise<Probe> {
  const probe: Probe = { status: 200, headers: {}, passed: false };
  const req = {
    ip: '127.0.0.1',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    user: { id: userId },
  } as unknown as Request;
  const res = {
    set(key: string, value: string) { probe.headers[key.toLowerCase()] = value; return res; },
    status(code: number) { probe.status = code; return res; },
    json() { return res; },
  } as unknown as Response;
  const next = (() => { probe.passed = true; }) as NextFunction;
  return Promise.resolve(middleware(req, res, next)).then(() => probe);
}

beforeEach(() => { _resetRateLimitStoreForTest(); });
afterAll(() => { _resetRateLimitStoreForTest(); });

describe('süreç-yerel sayaç deposu sınırsız büyümez', () => {
  it('tavanı aşan anahtar taşkını sayımı bozmadan sürer ve canlı sayaçlar korunur', async () => {
    const flood = rateLimit(1_000_000, 60_000, 'flood', { mode: 'user' });

    for (let i = 0; i <= MAX_STORE_SIZE; i += 1) {
      await drive(flood, `sel-${i}`);
    }
    // Tavan aşıldı: bundan sonraki her ölçüm süpürge yolundan geçer.
    const afterFlood = await drive(flood, 'sel-son');
    expect(afterFlood.passed).toBe(true);
    expect(afterFlood.headers['x-ratelimit-remaining']).toBe(String(1_000_000 - 1));

    // Süpürge CANLI sayaçları düşürmemeli: aynı kimliğin ardışık istekleri
    // birikmeye devam eder ve kota tükendiğinde 429 gelir.
    const strict = rateLimit(2, 60_000, 'sicak', { mode: 'user' });
    const first = await drive(strict, 'sicak-kullanici');
    const second = await drive(strict, 'sicak-kullanici');
    const third = await drive(strict, 'sicak-kullanici');

    expect(first.passed).toBe(true);
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    expect(second.passed).toBe(true);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    expect(third.passed).toBe(false);
    expect(third.status).toBe(429);
  }, 180_000);

  it('süpürge yalnızca en uzun pencereden eski girişleri atar; taze sayaç yaşar', async () => {
    const limiter = rateLimit(2, 60_000, 'supurge', { mode: 'user' });
    await drive(limiter, 'taze');

    pruneMemStore();

    // Taze giriş süpürgeden sağ çıktığı için ikinci istek 2/2'yi tüketir.
    const second = await drive(limiter, 'taze');
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    const third = await drive(limiter, 'taze');
    expect(third.status).toBe(429);
  });
});
