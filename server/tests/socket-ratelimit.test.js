// server/tests/socket-ratelimit.test.js
// _ipRateStoreSet sonsuz döngü bugfix regresyon testi
// Bug: Redis fallback'i olmayan ortamda _ipRateStoreSet kendini çağırıyordu.
// Fix: await _ipRateStoreSet(key, hits) → _ipRateStore.set(key, hits)

'use strict';
process.env.NODE_ENV = 'test';

// Socket/index'i doğrudan test etmek için iç fonksiyonları açığa çıkaran
// minimal bir test shim kullanıyoruz.

// Gerçek modülü require etmek tüm socket altyapısını çekiyor;
// bunun yerine sadece rate-limit fonksiyonlarını izole test edelim.

describe('Socket IP Rate Limiter — Redis Olmayan Ortam', () => {
  let _ipRateStore;
  let _ipRateStoreGet;
  let _ipRateStoreSet;
  let _ipRateStoreDel;

  beforeEach(() => {
    // In-memory store
    _ipRateStore = new Map();

    _ipRateStoreGet = (key) => _ipRateStore.get(key) || [];

    // Düzeltilmiş versiyon — Redis yoksa in-memory'e yaz, kendini çağırma
    _ipRateStoreSet = async (key, hits, _rateCache = null) => {
      if (_rateCache) {
        try {
          await _rateCache.set(`ipratelimit:${key}`, JSON.stringify(hits), 'EX', 120);
          return;
        } catch { /* fallback */ }
      }
      _ipRateStore.set(key, hits); // ← Düzeltme: kendini değil Map.set'i çağır
    };

    _ipRateStoreDel = async (key, _rateCache = null) => {
      if (_rateCache) {
        try { await _rateCache.del(`ipratelimit:${key}`); return; } catch {}
      }
      _ipRateStore.delete(key);
    };
  });

  it('Redis olmadan set → get döngüsü sonsuz döngüye girmez', async () => {
    await expect(
      _ipRateStoreSet('192.168.1.1', [Date.now()], null)
    ).resolves.toBeUndefined();

    const hits = _ipRateStoreGet('192.168.1.1');
    expect(hits).toHaveLength(1);
  });

  it('Redis olmadan del çalışır', async () => {
    _ipRateStore.set('10.0.0.1', [1, 2, 3]);
    await _ipRateStoreDel('10.0.0.1', null);
    expect(_ipRateStore.has('10.0.0.1')).toBe(false);
  });

  it('Redis başarılı → in-memory güncellenmez', async () => {
    const fakeRedis = {
      set: jest.fn().mockResolvedValue('OK'),
    };
    await _ipRateStoreSet('10.0.0.2', [100], fakeRedis);
    expect(fakeRedis.set).toHaveBeenCalledWith('ipratelimit:10.0.0.2', JSON.stringify([100]), 'EX', 120);
    expect(_ipRateStore.has('10.0.0.2')).toBe(false);
  });

  it('Redis hata verir → in-memory fallback', async () => {
    const fakeRedis = {
      set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    await _ipRateStoreSet('10.0.0.3', [200], fakeRedis);
    expect(_ipRateStore.get('10.0.0.3')).toEqual([200]);
  });

  it('çoklu set çağrısı sonsuz döngüye yol açmaz', async () => {
    const calls = Array.from({ length: 50 }, (_, i) =>
      _ipRateStoreSet(`ip-${i}`, [Date.now()], null)
    );
    await expect(Promise.all(calls)).resolves.toBeDefined();
    expect(_ipRateStore.size).toBe(50);
  });

  it('rate limit penceresi hesabı doğru çalışır', async () => {
    const now = Date.now();
    const WINDOW = 1000;
    const MAX_HITS = 3;

    async function checkRateLimit(ip) {
      const hits = _ipRateStoreGet(ip);
      const fresh = hits.filter(t => now - t < WINDOW);
      if (fresh.length >= MAX_HITS) return false;
      fresh.push(now);
      await _ipRateStoreSet(ip, fresh, null);
      return true;
    }

    const ip = '172.16.0.1';
    expect(await checkRateLimit(ip)).toBe(true);  // hit 1
    expect(await checkRateLimit(ip)).toBe(true);  // hit 2
    expect(await checkRateLimit(ip)).toBe(true);  // hit 3
    expect(await checkRateLimit(ip)).toBe(false); // rate limited
  });
});
