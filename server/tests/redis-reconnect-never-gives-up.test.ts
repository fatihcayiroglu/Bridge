'use strict';
process.env.NODE_ENV = 'test';

// ════════════════════════════════════════════════════════════════════════════
// YENİDEN BAĞLANMA ASLA PES ETMEZ
// ════════════════════════════════════════════════════════════════════════════
// v1.123'te tek kullanımlık bir ortamda ÖLÇÜLEN üretim arızası:
//
//   1. Redis durduruldu            → sunucu 503 (fail-closed; DOĞRU davranış)
//   2. ~30 sn sonra yeniden bağlanma bütçesi tükendi
//   3. Redis GERİ GELDİ, host'tan erişilebilirdi (`+PONG` doğrulandı)
//   4. Sunucu 60+ sn sonra hâlâ TÜM isteklere 503 dönüyordu ve YENİ hiçbir
//      `redis.reconnecting` olayı üretmiyordu — süreç yeniden başlatılmadan
//      ASLA toparlanmadı.
//
// Sebep: `reconnectStrategy` 10 denemeden sonra bir `Error` döndürüyordu.
// node-redis bunu "bir daha deneme" olarak yorumlar ve istemciyi KALICI
// olarak kapatır. Zincir şöyleydi:
//
//   istemci kalıcı ölü → `_isRedisAvailable` kalıcı false → hız sınırlayıcı
//   yetkili Redis komutunu bulamaz → fail-closed 503 → `/api/health` de 503
//   → yük dengeleyici TÜM örnekleri havuzdan çıkarır ve GERİ ALMAZ.
//
// Yani GEÇİCİ bir Redis kesintisi KALICI bir filo kesintisine dönüşüyordu.
//
// Fail-closed davranışın kendisi DOĞRUDUR ve bu testin konusu değildir
// (aksi hâlde Redis'i düşüren biri hız sınırlarını atlardı). Burada
// korunan tek değişmez şudur: KESİNTİ BİTTİĞİNDE GERİ DÖNEBİLMEK.
//
// Düzeltmeden sonra AYNI senaryo yeniden ölçüldü: 26 yeniden bağlanma
// denemesi, ikinci bir `redis.ready` ve sunucu 3 sn içinde KENDİLİĞİNDEN
// 200'e döndü.

let capturedOptions: { socket?: { reconnectStrategy?: (retries: number) => unknown } } | null = null;

function makeClient(name: string) {
  const client: Record<string, unknown> = {
    name,
    connect: jest.fn(async () => undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    duplicate: jest.fn(),
  };
  return client;
}

const pub = makeClient('pub');
const sub = makeClient('sub');
(pub.duplicate as jest.Mock).mockReturnValue(sub);

jest.mock('../lib/_optional-require', () => ({
  tryRequire: (id: string) => {
    if (id === 'redis') {
      return {
        createClient: jest.fn((options: typeof capturedOptions) => {
          capturedOptions = options;
          return pub;
        }),
      };
    }
    if (id === '@socket.io/redis-adapter') return { createAdapter: () => ({}) };
    return null;
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function loadAdapter() {
  process.env.REDIS_URL = 'redis://localhost:6379';
  jest.resetModules();
  capturedOptions = null;
  return require('../lib/redisAdapter') as typeof import('../lib/redisAdapter');
}

afterEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.REDIS_RECONNECT_MAX_DELAY_MS;
});

describe('Redis yeniden bağlanma stratejisi', () => {
  async function strategy(): Promise<(retries: number) => unknown> {
    const adapter = loadAdapter();
    await adapter.applyAdapter({ adapter: jest.fn() } as never);
    const fn = capturedOptions?.socket?.reconnectStrategy;
    expect(typeof fn).toBe('function');
    return fn as (retries: number) => unknown;
  }

  it('hiçbir deneme sayısında PES ETMEZ', async () => {
    const reconnect = await strategy();

    // Eski kod `retries > 10` için `Error` donduruyordu; `Error` donmek
    // node-redis'te "kalici olarak vazgec" demektir. Uzun bir kesinti
    // gercekcidir (dagitim, yeniden baslatma, ag bolunmesi) ve KALICI
    // olarak kapanmak icin gecerli bir sebep degildir.
    for (const retries of [0, 1, 5, 10, 11, 50, 1_000, 100_000]) {
      const delay = reconnect(retries);
      expect(delay).not.toBeInstanceOf(Error);
      expect(typeof delay).toBe('number');
    }
  });

  it('gecikmeyi sınırlar; kapalı bir Redis\'e karşı sıkı döngü kurmaz', async () => {
    const reconnect = await strategy();

    // Sinirsiz deneme, sinirsiz SIKLIK demek DEGILDIR: bekleme buyur ve
    // bir tavanda durur.
    expect(reconnect(0)).toBeLessThanOrEqual(reconnect(1) as number);
    expect(reconnect(1)).toBeLessThan(reconnect(5) as number);

    const ceiling = reconnect(100_000) as number;
    expect(ceiling).toBe(3_000);
    // Cok uzun bir kesintide bile deneme araligi tavanda kalir.
    expect(reconnect(1_000)).toBe(ceiling);
  });

  it('tavan ortam değişkeniyle ayarlanabilir', async () => {
    process.env.REDIS_RECONNECT_MAX_DELAY_MS = '750';
    const reconnect = await strategy();

    expect(reconnect(100_000)).toBe(750);
    // Tavan degisse de "pes etme" degismez.
    expect(reconnect(100_000)).not.toBeInstanceOf(Error);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
