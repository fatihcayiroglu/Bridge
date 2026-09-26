// server/tests/presence-visibility-recovery-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// VARLIK ÖNBELLEĞİ — GÖRÜNÜRLÜK OTORİTESİ, KURTARMA VE PUB/SUB
// ════════════════════════════════════════════════════════════════════════════
//
// "Çevrimdışı görün" bir GİZLİLİK tercihidir. Kümede bu tercihin otoritesi
// Redis'tir ve anahtar YOKLUĞU asla "görünür" anlamına gelmemelidir: bir
// Redis flush/restart sonrasında bu yorum, gizlenmek isteyen kullanıcıyı
// açığa çıkarırdı. Ölçülmemiş dallar tam olarak bu kurtarma yolu ve onun
// çevresidir:
//
//   · KURTARMA — açık otorite yoksa kalıcı DB tercihi aynı kilit altında
//     yeniden yazılır. Kurtarma sırasında başka bir düğüm anahtarı geri
//     yazmışsa o değer kullanılır (çift yazma olmaz).
//   · FAIL-CLOSED — DB okunamazsa kullanıcı GİZLİ sayılır.
//   · PUB/SUB — görünürlük bildirimi yalnız TAM biçimli mesajda uygulanır;
//     bozuk mesaj yerel ipucunu bozmamalıdır.
//   · SAYAÇ BÜTÜNLÜĞÜ — Redis'ten dönen sayaç güvenli tamsayı değilse
//     "sıfır soket" varsayılmaz; hata yükseltilir.

'use strict';
process.env.NODE_ENV = 'test';

const previousRedisUrl = process.env.REDIS_URL;

type Loaded = {
  presence: typeof import('../lib/presenceCache');
  luaEval: jest.Mock;
  getAuthoritative: jest.Mock;
  setAuthoritative: jest.Mock;
  publishToChannel: jest.Mock;
  findById: jest.Mock;
  warn: jest.Mock;
  subscriber: (raw: string) => void;
};

function load(options: { redis?: boolean } = {}): Loaded {
  jest.resetModules();
  if (options.redis) process.env.REDIS_URL = 'redis://cluster.test';
  else delete process.env.REDIS_URL;

  const luaEval = jest.fn().mockResolvedValue(1);
  const getAuthoritative = jest.fn().mockResolvedValue(null);
  const setAuthoritative = jest.fn().mockResolvedValue(undefined);
  const get = jest.fn().mockResolvedValue(null);
  const set = jest.fn().mockResolvedValue(undefined);
  const del = jest.fn().mockResolvedValue(undefined);
  const publishToChannel = jest.fn().mockResolvedValue(undefined);
  const findById = jest.fn().mockResolvedValue(null);
  const warn = jest.fn();
  let subscriber: (raw: string) => void = () => {};

  jest.doMock('../lib/redisAdapter', () => ({
    cache: {
      withKeyLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
      luaEval, luaEvalAuthoritative: luaEval,
      get, getAuthoritative, set, setAuthoritative, del, delAuthoritative: del,
    },
    subscribeToChannel: jest.fn(async (_channel: string, handler: (raw: string) => void) => {
      subscriber = handler;
      return async () => undefined;
    }),
    publishToChannel,
  }));
  jest.doMock('../lib/logger', () => ({ __esModule: true, default: { debug: jest.fn(), warn, info: jest.fn(), error: jest.fn() }, debug: jest.fn(), warn, info: jest.fn(), error: jest.fn() }));
  jest.doMock('../db/repositories', () => ({ Users: { findById } }));
  jest.doMock('../lib/userUtils', () => ({
    normalizePresenceVisibility: (v: unknown) => (v === 'hidden' ? 'hidden' : 'visible'),
  }));

  const presence = require('../lib/presenceCache') as typeof import('../lib/presenceCache');
  return {
    presence, luaEval, getAuthoritative, setAuthoritative, publishToChannel, findById, warn,
    get subscriber() { return subscriber; },
  } as Loaded;
}

beforeEach(() => { jest.useFakeTimers(); });

afterEach(() => {
  jest.useRealTimers();
  jest.resetModules();
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
  jest.clearAllMocks();
});

describe('görünürlük otoritesi kurtarma', () => {
  it('açık otorite yoksa kalıcı DB tercihi yeniden yazılır', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue(null);
    t.findById.mockResolvedValue({ _id: 'u1', presenceVisibility: 'hidden' });

    expect(await t.presence.isPresenceVisible('u1')).toBe(false);
    expect(t.setAuthoritative).toHaveBeenCalledWith('presence:visibility:u1', 'hidden', 0);

    t.findById.mockResolvedValue({ _id: 'u2', presenceVisibility: 'visible' });
    expect(await t.presence.isPresenceVisible('u2')).toBe(true);
    expect(t.setAuthoritative).toHaveBeenCalledWith('presence:visibility:u2', 'visible', 0);
  });

  it('kurtarma sırasında başka düğüm yazmışsa o değer kullanılır', async () => {
    const t = load({ redis: true });
    // Ilk okuma (hizli yol) bos; kilit icindeki ikinci okuma DOLU.
    t.getAuthoritative.mockResolvedValueOnce(null).mockResolvedValue('hidden');

    expect(await t.presence.isPresenceVisible('u1')).toBe(false);
    // Zaten yazilmis; kurtarma DB'ye HIC gitmez.
    expect(t.findById).not.toHaveBeenCalled();
    expect(t.setAuthoritative).not.toHaveBeenCalled();
  });

  it('kullanıcı satırı yoksa gizli sayılır', async () => {
    const t = load({ redis: true });
    t.findById.mockResolvedValue(null);

    expect(await t.presence.isPresenceVisible('yok')).toBe(false);
    expect(t.setAuthoritative).toHaveBeenCalledWith('presence:visibility:yok', 'hidden', 0);
  });

  it('DB okunamazsa fail-closed olunur ve uyarı bırakılır', async () => {
    const t = load({ redis: true });
    t.findById.mockRejectedValue(new Error('db offline'));

    expect(await t.presence.isPresenceVisible('u1')).toBe(false);
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'presence.visibility_recovery.failed' }),
      expect.any(String),
    );
  });

  it('açık otorite varsa kurtarma hiç çalışmaz', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue('visible');

    expect(await t.presence.isPresenceVisible('u1')).toBe(true);
    expect(t.findById).not.toHaveBeenCalled();
  });

  it('otorite okuması çökerse kullanıcı gizli sayılır', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockRejectedValue(new Error('redis down'));

    expect(await t.presence.isPresenceVisible('u1')).toBe(false);
  });
});

describe('pub/sub görünürlük bildirimi', () => {
  it('yalnız tam biçimli mesaj yerel ipucunu değiştirir', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue('visible');

    // Bozuk/eksik mesajlar YOK SAYILIR.
    t.subscriber('bozuk-json');
    t.subscriber(JSON.stringify({ event: 'presence:joined', userId: 'u1' }));
    t.subscriber(JSON.stringify({ event: 'presence:visibility', userId: 5, visible: false }));
    t.subscriber(JSON.stringify({ event: 'presence:visibility', userId: 'u1' }));
    expect(await t.presence.isPresenceVisible('u1')).toBe(true);

    // Tam biçimli mesaj uygulanir; kumede otorite yine Redis'tir.
    t.subscriber(JSON.stringify({ event: 'presence:visibility', userId: 'u1', visible: false }));
    t.subscriber(JSON.stringify({ event: 'presence:visibility', userId: 'u1', visible: true }));
    expect(await t.presence.isPresenceVisible('u1')).toBe(true);
  });

  it('tek düğüm modunda pub/sub ipucu doğrudan okunur', async () => {
    const t = load();

    t.subscriber(JSON.stringify({ event: 'presence:visibility', userId: 'u1', visible: false }));
    expect(await t.presence.isPresenceVisible('u1')).toBe(false);

    t.subscriber(JSON.stringify({ event: 'presence:visibility', userId: 'u1', visible: true }));
    expect(await t.presence.isPresenceVisible('u1')).toBe(true);
  });
});

describe('soket sayacı bütünlüğü', () => {
  it('güvenli olmayan sayaç sıfır soket sayılmaz', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue('visible');
    t.luaEval.mockResolvedValue('cok-fazla');

    await expect(t.presence.trackSocket('u1', 's1')).rejects.toThrow(/Invalid presence socket count/);
    // Basarisiz kayit yerel haritada iz BIRAKMAZ.
    expect(t.presence.socketCount('u1')).toBe(0);
  });

  it('negatif sayaç da reddedilir', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue('visible');
    t.luaEval.mockResolvedValue(-1);

    await expect(t.presence.trackSocket('u1', 's1')).rejects.toThrow(/Invalid presence socket count/);
  });

  it('koordinasyon yanıtı hiç gelmezse açık bir hata verilir', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue('visible');
    t.luaEval.mockResolvedValue(null);

    await expect(t.presence.trackSocket('u1', 's1'))
      .rejects.toThrow(/Redis presence coordination unavailable/);
  });

  it('gizli kullanıcı kümede paylaşılan sokete yazılmaz', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue('hidden');

    const count = await t.presence.trackSocket('u1', 's1', false);

    expect(count).toBe(1);
    expect(t.luaEval).not.toHaveBeenCalled();
  });

  it('serbest bırakma sırasında koordinasyon çökerse yanlış "çevrimdışı" bildirilmez', async () => {
    const t = load({ redis: true });
    t.getAuthoritative.mockResolvedValue('visible');
    t.luaEval.mockResolvedValueOnce(1);
    await t.presence.trackSocket('u1', 's1');

    t.luaEval.mockRejectedValueOnce(new Error('redis down'));
    const remaining = await t.presence.releaseSocket('u1', 's1');

    // Sifir DONMEZ: cagiran sahte bir global offline yaymaz.
    expect(remaining).toBeGreaterThanOrEqual(1);
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'presence.socket_release.redis_failed' }),
      expect.any(String),
    );
  });
});

describe('tek düğüm modu', () => {
  it('ilk görünür soket çevrimiçi yapar, son soket çevrimdışı yapar', async () => {
    const t = load();

    expect(await t.presence.trackSocket('u1', 's1')).toBe(1);
    expect(await t.presence.isUserOnline('u1')).toBe(true);
    expect(t.presence.activeSockets()).toBe(1);
    expect(t.presence.onlineUserCount()).toBe(1);

    expect(await t.presence.releaseSocket('u1', 's1')).toBe(0);
    expect(await t.presence.isUserOnline('u1')).toBe(false);
    expect(t.presence.activeSockets()).toBe(0);
  });

  it('gizli bağlanan kullanıcı çevrimiçi görünmez', async () => {
    const t = load();

    await t.presence.trackSocket('u1', 's1', false);

    expect(await t.presence.isPresenceVisible('u1')).toBe(false);
    expect(await t.presence.isUserOnline('u1')).toBe(false);
  });

  it('aynı kullanıcının ikinci soketi sayacı artırır ve tek soket kapanınca çevrimdışı olunmaz', async () => {
    const t = load();

    await t.presence.trackSocket('u1', 's1');
    expect(await t.presence.trackSocket('u1', 's2')).toBe(2);

    expect(await t.presence.releaseSocket('u1', 's1')).toBe(1);
    expect(await t.presence.isUserOnline('u1')).toBe(true);
  });

  it('bilinmeyen soketin serbest bırakılması sayacı bozmaz', async () => {
    const t = load();

    expect(await t.presence.releaseSocket('u-yok', 's-yok')).toBe(0);
    expect(t.presence.socketCount('u-yok')).toBe(0);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
