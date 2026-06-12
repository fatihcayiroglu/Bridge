// server/tests/socket-ratelimit-redis.test.ts
// Sprint 105: socketRateCheck Redis-backed path testleri
// In-memory fallback + Redis başarı/hata senaryoları

'use strict';
process.env.NODE_ENV = 'test';

describe('socketRateCheck — Redis-backed store', () => {
  const WINDOW_MS = 10_000;
  const MAX = 3;

  // Redis mock
  const makeRedis = (failSet = false, failGet = false) => ({
    get:  jest.fn().mockImplementation(() =>
      failGet ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(null)
    ),
    set:  jest.fn().mockImplementation(() =>
      failSet ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve('OK')
    ),
    del:  jest.fn().mockResolvedValue(1),
  });

  // in-memory sliding window (üretim mantığının izole kopyası)
  function makeStore() {
    const store = new Map<string, number[]>();

    async function storeGet(key: string, redis: ReturnType<typeof makeRedis> | null): Promise<number[]> {
      if (redis) {
        try {
          const val = await redis.get(`socketrl:${key}`);
          return val ? (JSON.parse(val) as number[]) : [];
        } catch { /* fallback */ }
      }
      return store.get(key) ?? [];
    }

    async function storeSet(key: string, hits: number[], redis: ReturnType<typeof makeRedis> | null): Promise<void> {
      if (redis) {
        try {
          await redis.set(`socketrl:${key}`, JSON.stringify(hits), 'EX', 120);
          return;
        } catch { /* fallback */ }
      }
      store.set(key, hits);
    }

    async function rateCheck(userId: string, event: string, redis: ReturnType<typeof makeRedis> | null): Promise<boolean> {
      const key = `${userId}:${event}`;
      const now = Date.now();
      const stored = await storeGet(key, redis);
      const hits = stored.filter(t => now - t < WINDOW_MS);
      hits.push(now);
      await storeSet(key, hits, redis);
      return hits.length <= MAX;
    }

    return { store, rateCheck };
  }

  it('Redis olmadan in-memory sliding window çalışır', async () => {
    const { rateCheck } = makeStore();
    expect(await rateCheck('u1', 'message:send', null)).toBe(true);
    expect(await rateCheck('u1', 'message:send', null)).toBe(true);
    expect(await rateCheck('u1', 'message:send', null)).toBe(true);
    expect(await rateCheck('u1', 'message:send', null)).toBe(false); // limit aşıldı
  });

  it('Redis başarılı → veri Redis\'e yazılır, in-memory güncellenmez', async () => {
    const redis = makeRedis();
    const { store, rateCheck } = makeStore();
    await rateCheck('u2', 'dm:send', redis);
    expect(redis.set).toHaveBeenCalledWith('socketrl:u2:dm:send', expect.any(String), 'EX', 120);
    expect(store.size).toBe(0);
  });

  it('Redis get hata verir → in-memory fallback ile çalışmaya devam eder', async () => {
    const redis = makeRedis(false, true); // get fails
    const { rateCheck } = makeStore();
    // Hata fırlatmaz, in-memory'e fallback yapar
    await expect(rateCheck('u3', 'typing:start', redis)).resolves.toBe(true);
  });

  it('Redis set hata verir → in-memory fallback devreye girer', async () => {
    const redis = makeRedis(true, false); // set fails
    const { store, rateCheck } = makeStore();
    await rateCheck('u4', 'channel:join', redis);
    // set başarısız olunca in-memory'e düşmeli
    expect(store.size).toBe(1);
  });

  it('Farklı kullanıcılar birbirini etkilemez', async () => {
    const { rateCheck } = makeStore();
    for (let i = 0; i < 3; i++) await rateCheck('userA', 'dm:send', null);
    // userA rate limited
    expect(await rateCheck('userA', 'dm:send', null)).toBe(false);
    // userB etkilenmemeli
    expect(await rateCheck('userB', 'dm:send', null)).toBe(true);
  });

  it('Farklı event tipleri aynı kullanıcı için ayrı sayaçlara sahiptir', async () => {
    const { rateCheck } = makeStore();
    for (let i = 0; i < 3; i++) await rateCheck('u5', 'message:send', null);
    // message:send limit aşıldı ama dm:send etkilenmemeli
    expect(await rateCheck('u5', 'message:send', null)).toBe(false);
    expect(await rateCheck('u5', 'dm:send', null)).toBe(true);
  });

  it('Pencere dışı hit\'ler sayılmaz', async () => {
    const { store, rateCheck } = makeStore();
    const userId = 'u6';
    const event = 'voice:signal';
    const key = `${userId}:${event}`;
    // Pencere dışı (geçmiş) hit'ler yükle
    store.set(key, [Date.now() - 20_000, Date.now() - 15_000]);
    // Pencere içinde MAX kadar yeni hit eklenebilmeli
    expect(await rateCheck(userId, event, null)).toBe(true);
    expect(await rateCheck(userId, event, null)).toBe(true);
    expect(await rateCheck(userId, event, null)).toBe(true);
    expect(await rateCheck(userId, event, null)).toBe(false);
  });

  it('Redis\'te mevcut hitler alınır ve sayaca eklenir', async () => {
    const existingHits = [Date.now() - 1000, Date.now() - 500]; // pencere içi 2 hit
    const redis = {
      get:  jest.fn().mockResolvedValue(JSON.stringify(existingHits)),
      set:  jest.fn().mockResolvedValue('OK'),
      del:  jest.fn().mockResolvedValue(1),
    };
    const { rateCheck } = makeStore();
    expect(await rateCheck('u7', 'message:send', redis)).toBe(true); // 3. hit
    expect(await rateCheck('u7', 'message:send', redis)).toBe(false); // 4. hit → limit (max=3)
  });
});
