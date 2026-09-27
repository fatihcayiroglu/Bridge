// server/tests/draw-store-authority-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ORTAK ÇİZİM OTURUM DEPOSU — BOZUK KAYIT VE OTORİTE SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
//
// Ortak tuval oturumu paylaşılan bir DURUMDUR. İki yanlış da kullanıcı
// verisini kaybettirir:
//
//   · BOZUK KAYIT = BOŞ TUVAL DEĞİL — kısmen yazılmış/elle düzenlenmiş bir
//     kayıt "oturum yok" sayılırsa herkesin çizimi SESSİZCE silinir. Depo
//     bunun yerine açık bir bütünlük hatası verir.
//   · KANAL KARIŞMASI — kayıt hangi kanala ait olduğunu kendi içinde taşır;
//     başka kanalın oturumu yüklenirse çizimler yanlış odaya sızar.
//   · ÇATALLANMA — paylaşılan otorite ilan edilmişken (REDIS_URL) erişilemezse
//     süreç-yerel bir kopyaya düşmek, düğüm başına ayrı tuval demektir.
//   · TEK DÜĞÜM — otorite ilan EDİLMEMİŞSE geçici Redis arızası süreç-yerel
//     depoya düşmelidir; ürün kullanılamaz hâle gelmemelidir.
//
// `draw-store.test.ts` mutlu yolu ölçer; burada arıza ve bütünlük dalları
// kapatılır. `REDIS_CONFIGURED` modül yüklenirken okunduğu için her dünya
// kendi taze modül kopyasıyla ölçülür.

process.env.NODE_ENV = 'test';

const getAuthoritative = jest.fn();
const setAuthoritative = jest.fn();
const delAuthoritative = jest.fn();
const withKeyLock = jest.fn();
let available = false;

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => available,
  cache: {
    get: getAuthoritative, set: setAuthoritative, del: delAuthoritative, withKeyLock,
    getAuthoritative, setAuthoritative, delAuthoritative,
  },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

type StoreModule = typeof import('../socket/handlers/activities/draw-store');
type DrawSession = import('../socket/handlers/activities/draw-together').DrawSession;

/** İstenen dünyayla (`REDIS_URL` var/yok) taze modül kopyası verir. */
function loadStore(redisUrl?: string): StoreModule {
  const previous = process.env.REDIS_URL;
  if (redisUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = redisUrl;
  let mod!: StoreModule;
  try {
    jest.isolateModules(() => { mod = require('../socket/handlers/activities/draw-store'); });
  } finally {
    if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous;
  }
  return mod;
}

function session(over: Partial<DrawSession> = {}): DrawSession {
  return {
    sessionId: 'sess-1', channelId: 'ch-1', strokes: [],
    activeStrokes: new Map(),
    participants: new Map([['sock-a', { userId: 'u1', displayName: 'A', color: '#fff' }]]),
    createdAt: 123, hostSocketId: 'sock-a',
    ...over,
  } as DrawSession;
}

function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'sess-1', channelId: 'ch-1', strokes: [],
    activeStrokes: [], participants: [], createdAt: 123, hostSocketId: 'sock-a',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  available = false;
  withKeyLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
});

describe('kalıcı kayıt bütünlüğü', () => {
  const corrupt: Array<[string, unknown]> = [
    ['nesne değil', 'düz metin'],
    // `null` BOZUK degil, "oturum yok" demektir; ayri bir testte olculur.
    ['oturum kimliği yok', stored({ sessionId: undefined })],
    ['oturum kimliği boş', stored({ sessionId: '' })],
    ['başka kanala ait', stored({ channelId: 'baska-kanal' })],
    ['çizgiler dizi değil', stored({ strokes: 'hepsi' })],
    ['etkin çizgiler dizi değil', stored({ activeStrokes: {} })],
    ['katılımcılar dizi değil', stored({ participants: {} })],
    ['zaman damgası sayı değil', stored({ createdAt: 'dün' })],
    ['zaman damgası kesirli', stored({ createdAt: 1.5 })],
    ['zaman damgası negatif', stored({ createdAt: -1 })],
    ['host kimliği metin değil', stored({ hostSocketId: 42 })],
  ];

  it.each(corrupt)('bozuk oturum (%s) boş tuval olarak kabul edilmez', async (_label, raw) => {
    const store = loadStore();
    available = true;
    getAuthoritative.mockResolvedValueOnce(raw);

    await expect(store.drawStore.get('ch-1')).rejects.toThrow(/Invalid persisted draw session/);
    expect(store.drawSessions.size).toBe(0);
  });

  it('bozuk katılımcı satırı da reddedilir', async () => {
    const store = loadStore();
    available = true;
    for (const participant of [null, { socketId: 1 }, { socketId: 's', userId: 2 }, { socketId: 's', userId: 'u', displayName: 3 }, { socketId: 's', userId: 'u', displayName: 'd' }]) {
      getAuthoritative.mockResolvedValueOnce(stored({ participants: [participant] }));
      await expect(store.drawStore.get('ch-1')).rejects.toThrow(/Invalid persisted draw participant/);
    }
  });

  it('bozuk etkin çizgi satırı da reddedilir', async () => {
    const store = loadStore();
    available = true;
    for (const active of [null, { socketId: 1, stroke: {} }, { socketId: 's' }, { socketId: 's', stroke: 'çizgi' }]) {
      getAuthoritative.mockResolvedValueOnce(stored({ activeStrokes: [active] }));
      await expect(store.drawStore.get('ch-1')).rejects.toThrow(/Invalid persisted draw active stroke/);
    }
  });

  it('kayıt yoksa oturum yok demektir', async () => {
    const store = loadStore();
    available = true;
    getAuthoritative.mockResolvedValueOnce(null);

    expect(await store.drawStore.get('ch-1')).toBeNull();
  });

  it('yazma sırasında kanal uyuşmazlığı reddedilir', async () => {
    const store = loadStore();

    await expect(store.drawStore.set('ch-1', session({ channelId: 'baska' })))
      .rejects.toThrow(/Draw session\/channel mismatch/);
    expect(store.drawSessions.size).toBe(0);
  });
});

describe('paylaşılan otorite ilan EDİLMİŞKEN', () => {
  const REDIS_URL = 'redis://127.0.0.1:6379';

  it('okuma arızası süreç-yerel kopyaya düşmez', async () => {
    const store = loadStore(REDIS_URL);
    available = true;
    getAuthoritative.mockRejectedValueOnce(new Error('redis down'));

    await expect(store.drawStore.get('ch-1')).rejects.toThrow('redis down');
    expect(store.drawSessions.size).toBe(0);
  });

  it('yazma arızası sessizce belleğe yazmaz', async () => {
    const store = loadStore(REDIS_URL);
    available = true;
    setAuthoritative.mockRejectedValueOnce(new Error('redis down'));

    await expect(store.drawStore.set('ch-1', session())).rejects.toThrow('redis down');
    expect(store.drawSessions.size).toBe(0);
  });

  it('silme arızası sessizce yutulmaz', async () => {
    const store = loadStore(REDIS_URL);
    available = true;
    delAuthoritative.mockRejectedValueOnce(new Error('redis down'));

    await expect(store.drawStore.del('ch-1')).rejects.toThrow('redis down');
  });

  it('Redis tamamen erişilemezken her işlem açık bir hata verir', async () => {
    const store = loadStore(REDIS_URL);
    available = false;

    await expect(store.drawStore.get('ch-1')).rejects.toThrow(/unavailable during get/);
    await expect(store.drawStore.set('ch-1', session())).rejects.toThrow(/unavailable during set/);
    await expect(store.drawStore.del('ch-1')).rejects.toThrow(/unavailable during delete/);
    expect(store.drawSessions.size).toBe(0);
  });
});

describe('tek düğüm modu', () => {
  it('geçici Redis arızasında süreç-yerel depoya düşülür', async () => {
    const store = loadStore();
    available = true;
    const live = session();

    getAuthoritative.mockRejectedValueOnce(new Error('redis blip'));
    expect(await store.drawStore.get('ch-1')).toBeNull();

    setAuthoritative.mockRejectedValueOnce(new Error('redis blip'));
    await store.drawStore.set('ch-1', live);
    expect(store.drawSessions.get('ch-1')).toBe(live);

    getAuthoritative.mockRejectedValueOnce(new Error('redis blip'));
    expect(await store.drawStore.get('ch-1')).toBe(live);

    delAuthoritative.mockRejectedValueOnce(new Error('redis blip'));
    await store.drawStore.del('ch-1');
    expect(store.drawSessions.has('ch-1')).toBe(false);
  });

  it('Redis hiç yokken oturum bellekte tutulur', async () => {
    const store = loadStore();
    available = false;
    const live = session();

    await store.drawStore.set('ch-1', live);
    expect(await store.drawStore.get('ch-1')).toBe(live);
    expect(await store.drawStore.get('bilinmeyen')).toBeNull();

    await store.drawStore.del('ch-1');
    expect(await store.drawStore.get('ch-1')).toBeNull();
  });
});

describe('mutasyon kilidi', () => {
  it('geçersiz kanal kimliği kilit almadan reddedilir', async () => {
    const store = loadStore();

    await expect(store.drawStore.withLock('', async () => 1)).rejects.toThrow(/Invalid draw channel id/);
    await expect(store.drawStore.withLock('x'.repeat(257), async () => 1)).rejects.toThrow(/Invalid draw channel id/);
    expect(withKeyLock).not.toHaveBeenCalled();
  });

  it('geçerli kanal kimliği paylaşılan kilit sahibine devredilir', async () => {
    const store = loadStore();

    expect(await store.drawStore.withLock('ch-1', async () => 'tamam')).toBe('tamam');
    expect(withKeyLock).toHaveBeenCalledWith(
      'draw-session:ch-1', expect.any(Function),
      { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 },
    );
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
