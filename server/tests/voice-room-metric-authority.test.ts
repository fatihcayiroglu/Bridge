// server/tests/voice-room-metric-authority.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SESLİ ODA METRİĞİ KANONİK DEPOYU OKUR — BELLEK YEDEĞİNİ DEĞİL
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK KUSUR (Final21, Faz 6 — F21-6-01) ──────────────────────
// `bridge_voice_rooms` Prometheus göstergesi şunu okuyordu:
//
//     Object.keys(voiceRooms).length
//
// `voiceRooms` ise yalnızca `_fallback` haritasını saran bir Proxy'dir ve
// `_saveRoom()` Redis yapılandırıldığında O HARİTAYA HİÇ YAZMAZ:
//
//     if (isRedisAvailable()) { ...redis'e yaz...; return; }   // erken donus
//     if (process.env.REDIS_URL) throw ...
//     _fallback.set(channelId, peers);                          // yalniz redis YOKKEN
//
// Sonuç: tek düğümlü geliştirmede gösterge DOĞRU çalışıyordu, ama Redis'li
// HER ÜRETİM kurulumunda SONSUZA DEK 0 okuyordu.
//
// ÜRETİMDE ÖLÇÜLDÜ (Final21 Faz 6): bir akran sesli odadayken Redis'te
// `bridge:cache:voice:room:<id>` anahtarı VARDI, `bridge_voice_rooms` ise
// 0 diyordu. Düzeltmeden sonra aynı koşulda 1 okundu.
//
// Bedeli: sesli kapasite üretim panolarında GÖRÜNMEZ; oda sayısına dayanan
// hiçbir alarm ateşlenmez; SFU aşırı yüklenmesi sessizce fark edilmez.
//
// ── BU DOSYA NEYİ KİLİTLER ─────────────────────────────────────────────────
// Kusur, KİMSE ÖLÇMEDİĞİ için vardı. Bu test onu geri gelemez hâle getirir:
// Redis otoritesi varken sayım KANONİK depodan gelmelidir; bellek yedeği boş
// olsa bile. Regresyon olursa test 0 görür ve düşer.

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../music', () => ({ readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })) }));

// eslint-disable-next-line no-var
var vdb: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  vdb = createMockDb();
  return vdb;
});
jest.mock('../db/index', () => require('../db/loader'));

let redisAvailable = true;
let countKeysCalls: string[] = [];
let countKeysResult = 0;

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => redisAvailable,
  cache: {
    countKeys: jest.fn(async (pattern: string) => {
      countKeysCalls.push(pattern);
      return countKeysResult;
    }),
    getAuthoritative: jest.fn(async () => null),
    setAuthoritative: jest.fn(async () => undefined),
    delAuthoritative: jest.fn(async () => undefined),
    withKeyLock: jest.fn(async (_k: string, fn: () => unknown) => fn()),
  },
}));

async function freshVoiceModule() {
  jest.resetModules();
  countKeysCalls = [];
  return import('../socket/handlers/voice');
}

describe('bridge_voice_rooms — kanonik depo otoritesi', () => {
  const originalRedisUrl = process.env.REDIS_URL;
  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  test('Redis otoritesi varken sayim KANONIK depodan gelir (bellek yedegi bos olsa da)', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    redisAvailable = true;
    countKeysResult = 3;

    const voice = await freshVoiceModule();

    // ESKI KUSURLU YOL: bellek yedegi BOS — eski kod burada 0 okurdu.
    expect(Object.keys(voice.voiceRooms as unknown as object)).toHaveLength(0);

    // KANONIK YOL: gercek oda sayisini vermelidir.
    await expect(voice.getVoiceRoomCount()).resolves.toBe(3);

    // Dogru anahtar uzayi sorulmali; onek `redisAdapter` icinde eklenir, bu
    // yuzden desen ONEKSIZ gecilir.
    expect(countKeysCalls).toContain('voice:room:*');
  });

  test('otorite yokken UYDURMA 0 dondurmez — son bilinen deger korunur', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    redisAvailable = true;
    countKeysResult = 7;

    const voice = await freshVoiceModule();
    await expect(voice.getVoiceRoomCount()).resolves.toBe(7);

    // Redis dususe: metrik "0 oda" diye YALAN SOYLEMEMELIDIR; bu, kapasite
    // panosunda gercek bir cokusu "hic trafik yok" gibi gosterirdi.
    redisAvailable = false;
    await expect(voice.getVoiceRoomCount()).resolves.toBe(7);
  });

  test('Redis YAPILANDIRILMAMISSA bellek yedegi kanoniktir', async () => {
    delete process.env.REDIS_URL;
    redisAvailable = false;

    const voice = await freshVoiceModule();
    await expect(voice.getVoiceRoomCount()).resolves.toBe(0);

    // Tek dugumlu kurulumda yedek GERCEK depodur; yazinca sayim artmalidir.
    (voice.voiceRooms as unknown as Record<string, unknown>)['ch-1'] = [
      { socketId: 's1', userId: 'u1', displayName: 'U', avatarColor: '#fff' },
    ];
    await expect(voice.getVoiceRoomCount()).resolves.toBe(1);
  });
});
