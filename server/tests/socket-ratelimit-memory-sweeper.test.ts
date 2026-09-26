// server/tests/socket-ratelimit-memory-sweeper.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BELLEK İÇİ SAYAÇ TEMİZLEYİCİSİ — SIZINTI VE YANLIŞ TEMİZLİK
// ════════════════════════════════════════════════════════════════════════════
//
// `socket/socketRateLimit.ts` modül yüklenirken bir `setInterval` kurar. Bu
// süpürücü ölçülmemişti (dosyanın fonksiyon kapsamı eşiğin altındaydı) ve
// iki gerçek arıza biçimi taşır:
//
//   1. HİÇ TEMİZLEMEZSE: Redis yokken her kullanıcı/olay çifti için bir dizi
//      süresiz büyür — uzun ömürlü bir süreçte sınırsız bellek büyümesi.
//   2. YANLIŞ ZAMANDA TEMİZLERSE: Redis aktifken bellek deposuna dokunmak
//      anlamsızdır; asıl tehlike ise TAZE vuruşları silmesidir — o durumda
//      hız sınırı sessizce SIFIRLANIR ve saldırgan yeniden bütçe kazanır.
//
// Bu dosya süpürücüyü gerçek zamanlayıcıyla değil, sahte zamanlayıcıyla
// sürer; sabit bir `sleep` YOKTUR.

process.env.NODE_ENV = 'test';

let redisAvailable = false;
jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => redisAvailable,
  redisClient: () => null,
  cache: { get: jest.fn(), set: jest.fn(), setIfAbsent: jest.fn(), del: jest.fn(), increment: jest.fn() },
}));

jest.useFakeTimers();

const { _socketRateStore } = require('../socket/socketRateLimit') as
  typeof import('../socket/socketRateLimit');

const SWEEP_INTERVAL_MS = 2 * 60_000;
const RETENTION_MS = 120_000;

beforeEach(() => {
  redisAvailable = false;
  _socketRateStore.clear();
});

afterAll(() => { jest.useRealTimers(); });

describe('bellek içi socket sayaç deposu süpürücüsü', () => {
  it('süresi geçmiş anahtarları DÜŞÜRÜR (sınırsız büyüme yok)', () => {
    const now = Date.now();
    _socketRateStore.set('user-a:message', [now - RETENTION_MS - 1_000]);
    expect(_socketRateStore.size).toBe(1);

    jest.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(_socketRateStore.has('user-a:message')).toBe(false);
  });

  it('TAZE vuruşları SİLMEZ — sınır sessizce sıfırlanmaz', () => {
    // Sahte zamanlayıcı SAATİ de ilerletir; bu yüzden "taze" kayıt, süpürme
    // ANINA göre taze olacak biçimde yerleştirilir.
    jest.advanceTimersByTime(SWEEP_INTERVAL_MS - 1_000);
    const nearSweep = Date.now();
    _socketRateStore.set('user-b:message', [nearSweep - 1_000, nearSweep]);

    jest.advanceTimersByTime(1_000);

    expect(_socketRateStore.get('user-b:message')).toHaveLength(2);
  });

  it('karışık bir anahtarda yalnızca eski vuruşlar atılır', () => {
    jest.advanceTimersByTime(SWEEP_INTERVAL_MS - 1_000);
    const nearSweep = Date.now();
    _socketRateStore.set('user-c:typing', [nearSweep - RETENTION_MS - 5_000, nearSweep - 500]);

    jest.advanceTimersByTime(1_000);

    expect(_socketRateStore.get('user-c:typing')).toHaveLength(1);
  });

  it('Redis aktifken bellek deposuna HİÇ dokunmaz', () => {
    const now = Date.now();
    redisAvailable = true;
    // Süresi geçmiş bir kayıt bile Redis modunda korunur: o modda bellek
    // deposu otorite değildir ve süpürücünün orada iş yapması gerekmez.
    _socketRateStore.set('user-d:message', [now - RETENTION_MS - 10_000]);

    jest.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(_socketRateStore.has('user-d:message')).toBe(true);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
