// server/tests/socket-ip-ratelimit-authority.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SOKET IP HIZ SINIRI — PAYLAŞILAN SAYAÇ OTORİTESİ
// ════════════════════════════════════════════════════════════════════════════
//
// Bu kapı, kimlik doğrulamadan ÖNCE çalışır ve bir IP'nin bağlantı kotasını
// belirler. Çok düğümlü kurulumda sayaç PAYLAŞILAN olmak zorundadır. Ölçülmemiş
// dalların taşıdığı riskler:
//
//   · SAYAÇ BÖLÜNMESİ — `REDIS_URL` tanımlıyken Redis düşerse süreç-içi sayaca
//     DÖNÜLMEZ: her düğüm ayrı sayarsa saldırgan kotayı düğüm sayısı kadar
//     çarpar. Doğru davranış REDDETMEKTİR (fail-closed).
//   · İHLAL SAYACI — otomatik ban eşiği atomik artışa dayanır; GET+SET
//     eşzamanlı reddetmelerde artış KAYBEDER.
//   · ÇİFT BAN — zaten banlı IP yeniden banlanmamalı, ban hatası kapıyı
//     açmamalıdır.

process.env.NODE_ENV = 'test';
process.env.RL_SOCKET_CONNECT_MAX = '2';
process.env.RL_AUTO_BAN_THRESHOLD = '3';
delete process.env.REDIS_URL;

const slidingWindowCount = jest.fn();
const increment = jest.fn();
const del = jest.fn();
const redisAvailable = jest.fn(() => false);
const getBan = jest.fn();
const banIp = jest.fn();

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    slidingWindowCount: (...args: unknown[]) => slidingWindowCount(...args),
    increment: (...args: unknown[]) => increment(...args),
    del: (...args: unknown[]) => del(...args),
  },
  isRedisAvailable: () => redisAvailable(),
}));
jest.mock('../middleware/ipBan', () => ({
  getBan: (...args: unknown[]) => getBan(...args),
  banIp: (...args: unknown[]) => banIp(...args),
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ipRateCheck } from '../socket/ipRateLimit';

type Module = typeof import('../socket/ipRateLimit');

/** Aynı modülü REDIS_URL tanımlıyken taze bir örnekle yükler. */
function withRedisConfigured(): Module {
  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://localhost:6379';
  let loaded: Module | null = null;
  try {
    jest.isolateModules(() => { loaded = require('../socket/ipRateLimit') as Module; });
  } finally {
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
  if (!loaded) throw new Error('modül yüklenemedi');
  return loaded;
}

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1) % 250}`;

beforeEach(() => {
  jest.clearAllMocks();
  redisAvailable.mockReturnValue(false);
  slidingWindowCount.mockResolvedValue(1);
  increment.mockResolvedValue(1);
  del.mockResolvedValue(undefined);
  getBan.mockResolvedValue(null);
  banIp.mockResolvedValue(undefined);
});

// ════════════════════════════════════════════════════════════════════════════
describe('pencere sayacı', () => {
  it('bilinmeyen olay kapıya takılmaz', async () => {
    expect(await ipRateCheck(nextIp(), 'unknown-event')).toBe(true);
    expect(slidingWindowCount).not.toHaveBeenCalled();
  });

  it('kota içindeki bağlantılar geçer, aşan REDDEDİLİR (bellek içi)', async () => {
    const ip = nextIp();

    expect(await ipRateCheck(ip, 'connect')).toBe(true);
    expect(await ipRateCheck(ip, 'connect')).toBe(true);
    expect(await ipRateCheck(ip, 'connect')).toBe(false);
  });

  it('Redis bağlıyken sayaç PAYLAŞILAN depodan okunur', async () => {
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockResolvedValue(1);
    const ip = nextIp();

    expect(await ipRateCheck(ip, 'connect')).toBe(true);
    expect(slidingWindowCount).toHaveBeenCalledWith(`ipratelimit:ip:${ip}:connect`, 60_000, expect.any(Number));

    slidingWindowCount.mockResolvedValue(99);
    expect(await ipRateCheck(ip, 'connect')).toBe(false);
  });

  it('Redis sayaç DÖNDÜREMEZSE (null) bellek içi kotaya düşülür', async () => {
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockResolvedValue(null);
    const ip = nextIp();

    expect(await ipRateCheck(ip, 'connect')).toBe(true);
    expect(await ipRateCheck(ip, 'connect')).toBe(true);
    expect(await ipRateCheck(ip, 'connect')).toBe(false);
  });

  it('Redis PATLARSA (yapılandırılmamışken) bellek içi kotaya düşülür', async () => {
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockRejectedValue(new Error('redis down'));
    const ip = nextIp();

    expect(await ipRateCheck(ip, 'connect')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ihlal sayacı ve otomatik ban', () => {
  const exceed = async (ip: string) => {
    await ipRateCheck(ip, 'connect');
    await ipRateCheck(ip, 'connect');
    return ipRateCheck(ip, 'connect');
  };

  it('eşiğe ulaşmayan ihlal BAN üretmez', async () => {
    const ip = nextIp();

    expect(await exceed(ip)).toBe(false);

    expect(banIp).not.toHaveBeenCalled();
  });

  it('eşiğe ulaşan ihlal otomatik ban uygular ve sayacı SIFIRLAR', async () => {
    const ip = nextIp();
    await exceed(ip);
    await ipRateCheck(ip, 'connect');

    expect(await ipRateCheck(ip, 'connect')).toBe(false);

    expect(banIp).toHaveBeenCalledWith(ip, expect.objectContaining({
      adminId: 'system', durationMs: expect.any(Number),
    }));
    // Sıfırlama sonrası aynı IP yeniden eşiğe ulaşana kadar banlanmaz.
    banIp.mockClear();
    await ipRateCheck(ip, 'connect');
    expect(banIp).not.toHaveBeenCalled();
  });

  it('ZATEN banlı IP yeniden banlanmaz', async () => {
    getBan.mockResolvedValue({ ip: 'x', reason: 'önceki' });
    const ip = nextIp();
    await exceed(ip);
    await ipRateCheck(ip, 'connect');
    await ipRateCheck(ip, 'connect');

    expect(banIp).not.toHaveBeenCalled();
  });

  it('ban kaydı PATLARSA kapı yine KAPALI kalır', async () => {
    getBan.mockRejectedValue(new Error('ban store down'));
    const ip = nextIp();
    await exceed(ip);
    await ipRateCheck(ip, 'connect');

    expect(await ipRateCheck(ip, 'connect')).toBe(false);
  });

  it('Redis bağlıyken ihlal sayacı ATOMİK artırılır ve sıfırlama Redis’e gider', async () => {
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockResolvedValue(99);
    increment.mockResolvedValue(3);
    const ip = nextIp();

    expect(await ipRateCheck(ip, 'connect')).toBe(false);

    expect(increment).toHaveBeenCalledWith(`ipviolation:${ip}`, 3600);
    expect(del).toHaveBeenCalledWith(`ipviolation:${ip}`);
  });

  it('ihlal sayacı sıfırlama PATLARSA akış sürer', async () => {
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockResolvedValue(99);
    increment.mockResolvedValue(3);
    del.mockRejectedValue(new Error('redis down'));
    const ip = nextIp();

    expect(await ipRateCheck(ip, 'connect')).toBe(false);
    expect(banIp).toHaveBeenCalled();
  });

  it('Redis ihlal sayacı PATLARSA (yapılandırılmamışken) bellek içi sayaç kullanılır', async () => {
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockResolvedValue(99);
    increment.mockRejectedValue(new Error('redis down'));
    const ip = nextIp();

    expect(await ipRateCheck(ip, 'connect')).toBe(false);
    expect(banIp).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// `REDIS_URL` tanımlıysa paylaşılan sayaç KANONİKTİR; süreç-içi kotaya
// seyreltme yapılmaz. Bu karar modül yüklenirken okunur.
describe('REDIS_URL tanımlıyken fail-closed', () => {
  it('Redis erişilemezken bağlantı REDDEDİLİR', async () => {
    const mod = withRedisConfigured();
    redisAvailable.mockReturnValue(false);

    expect(await mod.ipRateCheck(nextIp(), 'connect')).toBe(false);
  });

  it('Redis pencere sorgusu PATLARSA bağlantı REDDEDİLİR', async () => {
    const mod = withRedisConfigured();
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockRejectedValue(new Error('redis down'));

    expect(await mod.ipRateCheck(nextIp(), 'connect')).toBe(false);
  });

  it('ihlal sayacı PATLARSA yerel sayaç MUTASYONA UĞRAMAZ ve red korunur', async () => {
    const mod = withRedisConfigured();
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockResolvedValue(99);
    increment.mockRejectedValue(new Error('redis down'));

    expect(await mod.ipRateCheck(nextIp(), 'connect')).toBe(false);
    expect(banIp).not.toHaveBeenCalled();
  });

  it('Redis erişilemezken ihlal sayacı da yerel belleğe yazmaz', async () => {
    const mod = withRedisConfigured();
    redisAvailable.mockReturnValue(true);
    slidingWindowCount.mockResolvedValue(99);
    redisAvailable.mockReturnValueOnce(true).mockReturnValue(false);

    expect(await mod.ipRateCheck(nextIp(), 'connect')).toBe(false);
    expect(banIp).not.toHaveBeenCalled();
  });
});
