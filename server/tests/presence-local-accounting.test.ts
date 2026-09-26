// server/tests/presence-local-accounting.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// presenceCache — TEK DUGUM MUHASEBESI VE YAZMA KISMA (THROTTLE)
// ════════════════════════════════════════════════════════════════════════════
// `presence-cluster-contract.test.ts` KUME sahipligini olcer (baska bir dugum
// hâlâ soket tutuyorken yanlis "cevrimdisi" yazilmamasi). Bu dosya ayni
// modulun TEK DUGUM tarafini olcer — Redis yapilandirilmamis, yani cogu
// self-host kurulumunun gercek calisma bicimi.
//
// Olculen uc sozlesme:
//
// 1. SAYIM. `socketCount` / `activeSockets` / `onlineUserCount` uc AYRI
//    soruyu yanitlar: bu kullanicinin kac sekmesi var, sunucuda toplam kac
//    soket var, kac AYRI kullanici cevrimici. Bunlarin karismasi uye
//    listesinde ve olcumlerde yanlis sayilar uretir.
//
// 2. SERBEST BIRAKMA. Son soket dusene kadar kullanici cevrimici KALIR —
//    ikinci sekmeyi kapatan biri aninda cevrimdisi gorunmemelidir.
//
// 3. YAZMA KISMA. `throttleStatusWrite` ayni durumu ARKA ARKAYA veritabanina
//    yazmayi engeller. Ama onbellek arizasinda GUVENLI TARAFA duser ve
//    "yaz" der: kaybolan bir durum guncellemesi, gereksiz bir yazmadan
//    daha kotudur.
process.env.NODE_ENV = 'test';

type PresenceModule = typeof import('../lib/presenceCache');

/** Redis YAPILANDIRILMAMIS bir surec icin taze bir modul ornegi kurar. */
async function loadPresence(cacheOverrides: Record<string, unknown> = {}): Promise<PresenceModule> {
  const store = new Map<string, unknown>();
  const cache = {
    withKeyLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    del: jest.fn(async (key: string) => { store.delete(key); }),
    getAuthoritative: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    setAuthoritative: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    delAuthoritative: jest.fn(async (key: string) => { store.delete(key); }),
    luaEval: jest.fn(async () => 1),
    luaEvalAuthoritative: jest.fn(async () => 1),
    setIfAbsentAuthoritative: jest.fn(async () => true),
    subscribe: jest.fn(async () => undefined),
    publish: jest.fn(async () => undefined),
    ...cacheOverrides,
  };
  // Modul `cache` disinda kanal yardimcilarini da ic aktarir; eksik birakmak
  // gercek bir kusur gibi gorunen bir `TypeError` uretirdi.
  jest.doMock('../lib/redisAdapter', () => ({
    cache,
    publishToChannel: jest.fn(async () => undefined),
    subscribeToChannel: jest.fn(async () => undefined),
  }));
  jest.doMock('../lib/logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));
  let mod!: PresenceModule;
  await jest.isolateModulesAsync(async () => { mod = await import('../lib/presenceCache'); });
  return mod;
}

const previousRedisUrl = process.env.REDIS_URL;

beforeEach(() => {
  jest.useFakeTimers();
  delete process.env.REDIS_URL;   // tek dugum
});

afterEach(() => {
  jest.useRealTimers();
  jest.resetModules();
  jest.clearAllMocks();
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('socket accounting answers three distinct questions', () => {
  it('counts tabs per user, sockets in total and distinct online users', async () => {
    const presence = await loadPresence();

    await presence.trackSocket('u1', 'sock-a');
    await presence.trackSocket('u1', 'sock-b');
    await presence.trackSocket('u2', 'sock-c');

    expect(presence.socketCount('u1')).toBe(2);
    expect(presence.socketCount('u2')).toBe(1);
    expect(presence.activeSockets()).toBe(3);
    expect(presence.onlineUserCount()).toBe(2);
  });

  it('reports nothing for a user who never connected', async () => {
    const presence = await loadPresence();
    expect(presence.socketCount('ghost')).toBe(0);
    expect(presence.activeSockets()).toBe(0);
    expect(presence.onlineUserCount()).toBe(0);
  });

  it('ignores a repeated socket id instead of double counting', async () => {
    const presence = await loadPresence();
    await presence.trackSocket('u1', 'sock-a');
    await presence.trackSocket('u1', 'sock-a');
    expect(presence.socketCount('u1')).toBe(1);
    expect(presence.activeSockets()).toBe(1);
  });

  it('keeps a user online until the last tab closes', async () => {
    const presence = await loadPresence();
    await presence.trackSocket('u1', 'sock-a');
    await presence.trackSocket('u1', 'sock-b');

    await presence.releaseSocket('u1', 'sock-a');
    // Ikinci sekmeyi kapatan biri ANINDA cevrimdisi gorunmemelidir.
    expect(presence.socketCount('u1')).toBe(1);
    expect(presence.onlineUserCount()).toBe(1);

    await presence.releaseSocket('u1', 'sock-b');
    expect(presence.socketCount('u1')).toBe(0);
    expect(presence.onlineUserCount()).toBe(0);
    expect(presence.activeSockets()).toBe(0);
  });

  it('tolerates releasing a socket that was never tracked', async () => {
    const presence = await loadPresence();
    // Bilinmeyen soketin serbest birakilmasi KALAN sayiyi bildirir (0) ve
    // hicbir sayaci eksiye dusurmez.
    await expect(presence.releaseSocket('u1', 'never')).resolves.toBe(0);
    expect(presence.onlineUserCount()).toBe(0);
    expect(presence.activeSockets()).toBe(0);
  });

  it('keeps separate users independent when one disconnects', async () => {
    const presence = await loadPresence();
    await presence.trackSocket('u1', 'a');
    await presence.trackSocket('u2', 'b');
    await presence.releaseSocket('u1', 'a');

    expect(presence.onlineUserCount()).toBe(1);
    expect(presence.socketCount('u2')).toBe(1);
  });
});

describe('status writes are throttled but fail safe', () => {
  it('writes the first time and suppresses an identical repeat', async () => {
    const presence = await loadPresence();
    await expect(presence.throttleStatusWrite('u1', 'online')).resolves.toBe(true);
    await expect(presence.throttleStatusWrite('u1', 'online')).resolves.toBe(false);
  });

  it('writes again as soon as the status actually changes', async () => {
    const presence = await loadPresence();
    await presence.throttleStatusWrite('u1', 'online');
    await expect(presence.throttleStatusWrite('u1', 'idle')).resolves.toBe(true);
    await expect(presence.throttleStatusWrite('u1', 'idle')).resolves.toBe(false);
  });

  it('throttles each user separately', async () => {
    const presence = await loadPresence();
    await presence.throttleStatusWrite('u1', 'online');
    // Baska kullanicinin ilk yazmasi u1 yuzunden BASTIRILMAZ.
    await expect(presence.throttleStatusWrite('u2', 'online')).resolves.toBe(true);
  });

  it('falls back to writing when the cache read fails', async () => {
    const presence = await loadPresence({
      get: jest.fn(async () => { throw new Error('cache down'); }),
    });
    // Kaybolan bir durum guncellemesi, gereksiz bir yazmadan DAHA KOTUDUR.
    await expect(presence.throttleStatusWrite('u1', 'online')).resolves.toBe(true);
  });

  it('still reports a write when persisting the throttle marker fails', async () => {
    const presence = await loadPresence({
      set: jest.fn(async () => { throw new Error('cache write down'); }),
    });
    await expect(presence.throttleStatusWrite('u1', 'online')).resolves.toBe(true);
  });
});

describe('membership cache is an optimisation, never a gate', () => {
  it('fetches once and serves the cached value afterwards', async () => {
    const presence = await loadPresence();
    // URUN SOZLESMESI: `fetchFn` UYELIK SATIRLARI doner
    // (`() => Promise<Array<{ serverId: string }>>`), dizge degil. Ikiz dizge
    // donduruyordu; oysa cagiranlar (`socket/handlers/infra.ts`) `m.serverId`
    // okuyor. Yani test, urunun GERCEKTEN gordugu veriyi olcmuyordu.
    const memberships = [{ serverId: 's1' }, { serverId: 's2' }];
    const fetchFn = jest.fn(async () => memberships);

    await expect(presence.getMembershipsCached('u1', fetchFn)).resolves.toEqual(memberships);
    await expect(presence.getMembershipsCached('u1', fetchFn)).resolves.toEqual(memberships);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refetches after an explicit invalidation', async () => {
    const presence = await loadPresence();
    const fetchFn = jest.fn(async () => [{ serverId: 's1' }]);

    await presence.getMembershipsCached('u1', fetchFn);
    await presence.invalidateMemberships('u1');
    await presence.getMembershipsCached('u1', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('still returns real memberships when the cache layer is broken', async () => {
    const presence = await loadPresence({
      get: jest.fn(async () => { throw new Error('cache down'); }),
      set: jest.fn(async () => { throw new Error('cache down'); }),
    });
    const fetchFn = jest.fn(async () => [{ serverId: 's1' }]);
    // Onbellek arizasi UYELIGI kaybettirmez; yalnizca hizlandirmayi kaybettirir.
    await expect(presence.getMembershipsCached('u1', fetchFn)).resolves.toEqual([{ serverId: 's1' }]);
  });

  it('survives an invalidation while the cache is unavailable', async () => {
    const presence = await loadPresence({
      del: jest.fn(async () => { throw new Error('cache down'); }),
    });
    await expect(presence.invalidateMemberships('u1')).resolves.toBeUndefined();
  });
});

describe('manual offline and visibility', () => {
  it('reports a tracked user as online and an unknown one as offline', async () => {
    const presence = await loadPresence();
    await presence.markOnline('u1');
    await expect(presence.isUserOnline('u1')).resolves.toBe(true);
    await expect(presence.isUserOnline('nobody')).resolves.toBe(false);
  });

  it('marking offline clears the online marker', async () => {
    const presence = await loadPresence();
    await presence.markOnline('u1');
    await presence.markOffline('u1');
    await expect(presence.isUserOnline('u1')).resolves.toBe(false);
  });

  it('treats a cache failure as not-online rather than guessing', async () => {
    const presence = await loadPresence({
      get: jest.fn(async () => { throw new Error('cache down'); }),
    });
    // Gorunurluk bilinemiyorsa CEVRIMICI iddia edilmez.
    await expect(presence.isUserOnline('u1')).resolves.toBe(false);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
