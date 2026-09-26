// server/tests/pg-integration/redis-cache-invalidation.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK REDIS — ÖNBELLEK GEÇERSİZ KILMA GERÇEKTEN SİLİYOR MU?
// ════════════════════════════════════════════════════════════════════════════
// `lib/messageCache.ts` bir kanalın önbelleğe alınmış ilk-sayfa girdilerini
// `cache.invalidatePattern` ile düşürür. Mock'lanmış bir Redis testi yalnızca
// "invalidatePattern ÇAĞRILDI" diyebilir; anahtarların GERÇEKTEN silindiğini
// KANITLAYAMAZ.
//
// ── ÖLÇÜLEN AÇIK ──────────────────────────────────────────────────────────
// `invalidatePattern` SCAN imlecini SAYI olarak veriyordu. @redis/client 6
// imleç için `RedisArgument` (string | Buffer) ister ve sayı verilince komut
// KODLAMA aşamasında fırlatır:
//
//     "arguments[1]" must be of type "string | Buffer", got number instead.
//
// Çağıran (`invalidateChannelMessages`) bunu "kritik olmayan" sayıp yutar ve
// yalnızca `logger.debug` ile geçer. Sonuç: GERÇEK Redis ile geçersiz kılma
// HER ZAMAN sessizce başarısızdı — kanal ilk-sayfa önbelleği HİÇ düşmüyordu.
// Mesaj gönderen kullanıcı soket push'u sayesinde güncel görür; ama sayfayı
// YENİLEYEN, kanaldan çıkıp DÖNEN ya da İKİNCİ CİHAZDAN bakan kullanıcı
// adaptif TTL boyunca (45 saniyeye kadar) ESKİ listeyi görür.
//
// Bu süit anahtarları gerçek Redis'e yazar, geçersiz kılmayı çağırır ve
// anahtarların GİTTİĞİNİ doğrular. Sayısal imleç geri gelirse bu düşer.
//
// NOT: `PG_TEST_URL` harness'ında çalışır ama PostgreSQL kullanmaz; yalnızca
// `REDIS_TEST_URL` gerektirir.

const REDIS_URL = process.env.REDIS_TEST_URL;
const RUN = REDIS_URL ? describe : describe.skip;

RUN('gerçek Redis — kanal mesaj önbelleği gerçekten düşürülür', () => {
  type CacheModule = typeof import('../../lib/redisAdapter');
  type MessageCacheModule = typeof import('../../lib/messageCache');

  let adapter!: CacheModule;
  let messageCache!: MessageCacheModule;
  const channelId = `pgtest-chan-${Date.now()}`;

  beforeAll(async () => {
    process.env.REDIS_URL = REDIS_URL;
    jest.isolateModules(() => {
      adapter = require('../../lib/redisAdapter');
      messageCache = require('../../lib/messageCache');
    });
    // Bağlantı `applyAdapter` ile kurulur (üretimde de aynı giriş noktası).
    // Socket.io olmadan çağrılabilir: adapter takma adımı `io.adapter`
    // fonksiyon değilse atlanır, bağlantı yine de açılır.
    await adapter.applyAdapter({});
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !adapter.isRedisAvailable()) {
      await new Promise(r => setTimeout(r, 100));
    }
    // GERÇEK Redis şart: in-memory'ye düşerse bu süit hiçbir şey kanıtlamaz.
    expect(adapter.isRedisAvailable()).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await adapter.cache.invalidatePattern(messageCache.channelMessagesCachePrefix(channelId));
    await adapter.disconnect();
  });

  it('drops EVERY cached page size for the channel, not just the well-known ones', async () => {
    const prefix = messageCache.channelMessagesCachePrefix(channelId);
    // Sayfa boyutu 1..100 arası HERHANGİ bir değer olabilir; önek bazlı
    // geçersiz kılmanın anlamı tam olarak budur.
    for (const limit of [25, 50, 100]) {
      await adapter.cache.set(`${prefix}first:${limit}`, { stale: true, limit }, 60);
    }
    for (const limit of [25, 50, 100]) {
      expect(await adapter.cache.get(`${prefix}first:${limit}`)).not.toBeNull();
    }

    await messageCache.invalidateChannelMessages(channelId);

    for (const limit of [25, 50, 100]) {
      // GERÇEK iddia: anahtar GİTMİŞ olmalı. Sayısal imleçle bu üçü de
      // yerinde kalıyordu ve hata yutulduğu için çağıran BAŞARILI sanıyordu.
      expect(await adapter.cache.get(`${prefix}first:${limit}`)).toBeNull();
    }
  }, 30_000);

  it('leaves OTHER channels untouched', async () => {
    const other = `${channelId}-other`;
    const mine = messageCache.channelMessagesCachePrefix(channelId);
    const theirs = messageCache.channelMessagesCachePrefix(other);

    await adapter.cache.set(`${mine}first:50`, { who: 'mine' }, 60);
    await adapter.cache.set(`${theirs}first:50`, { who: 'theirs' }, 60);

    await messageCache.invalidateChannelMessages(channelId);

    expect(await adapter.cache.get(`${mine}first:50`)).toBeNull();
    // Önek çok geniş olsaydı komşu kanalın önbelleği de düşerdi: her mesaj
    // gönderiminde tüm kanalların önbelleği boşalır, önbellek anlamsızlaşırdı.
    expect(await adapter.cache.get(`${theirs}first:50`)).not.toBeNull();

    await adapter.cache.invalidatePattern(theirs);
  }, 30_000);

  it('is a no-op — not a throw — when the channel has nothing cached', async () => {
    // SCAN boş sonuç döndürdüğünde `del` hiç çağrılmamalı; boş anahtar
    // dizisiyle DEL çağırmak Redis'te hata verir.
    await expect(messageCache.invalidateChannelMessages(`${channelId}-empty`))
      .resolves.toBeUndefined();
  }, 30_000);

  it('surfaces nothing to the caller but genuinely clears a large key set', async () => {
    const prefix = messageCache.channelMessagesCachePrefix(`${channelId}-bulk`);
    // COUNT 100'dür; birden fazla SCAN turu gerektirecek kadar anahtar yaz ki
    // imleç ilerletme mantığı (ilk turdan sonra imleç ARTIK '0' değildir)
    // gerçekten yürüsün.
    for (let i = 0; i < 250; i += 1) {
      await adapter.cache.set(`${prefix}page:${i}`, { i }, 60);
    }
    await messageCache.invalidateChannelMessages(`${channelId}-bulk`);
    for (const i of [0, 99, 100, 199, 249]) {
      expect(await adapter.cache.get(`${prefix}page:${i}`)).toBeNull();
    }
  }, 60_000);
});

export {};
