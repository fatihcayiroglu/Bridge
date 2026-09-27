import { present } from './helpers/narrow';
// server/tests/chess-store-cluster-authority.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// chess-store — COK DUGUMDE OYUN DURUMU VE YARIS KAZANANI
// ════════════════════════════════════════════════════════════════════════════
// `chess-store.test.ts` tek dugum yedeğini olcer. Bu dosya `REDIS_URL`
// TANIMLI hâli olcer, cunku iki kritik islem orada CAS (compare-and-set)
// olarak yasar:
//
//   · `markGameOver` — iki oyuncu AYNI ANDA `resign` / `draw_accept`
//     gonderirse oyun IKI kez bitmemelidir. Lua betigi "gameOver false ise
//     true yap" isini TEK adimda yapar; yalnizca BIR cagri `true` alir.
//   · `claimBlack`   — bos siyah koltuga iki kisi ayni anda oturamaz.
//
// Bu yarislari kaybetmek gorunur bir cokme uretmez: oyun iki kez biter,
// iki kisi ayni koltuga oturur ve tahta oyuncular arasinda AYRISIR.
//
// Ucuncu sozlesme: Redis yapilandirilmis ama erisilemezse hicbir islem
// surec-ici bir kopyaya DUSMEZ — cunku o kopya diger dugumun oyununu
// bilmez ve iki ayri tahta uretirdi.
process.env.NODE_ENV = 'test';

const previousRedisUrl = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://chess-cluster.test:6379';

// ══════════════════════════════════════════════════════════════════════════
// IKIZLER `cache` API'SININ GERCEK IMZALARIYLA TIPLENIR
// ══════════════════════════════════════════════════════════════════════════
// Onceden hem ikizler tipsizdi hem de her sarmalayici
// `as unknown as (...x: unknown[]) => unknown` yaziyordu. Bedeli:
// `mock.calls[0]` BOS TUPLE olarak tiplenip `as [string, unknown, number]`
// donusumune zorluyordu — yani cagri kaydi hakkinda hicbir sey DOGRULANMIYORDU.
// Acik jenerikler (lib/redisAdapter.ts imzalari) hem cast'leri hem de
// TS2352'yi kaldiriyor.
type LockOptions = { leaseSeconds?: number; waitMs?: number; retryMs?: number };

const isRedisAvailable = jest.fn<boolean, []>(() => true);
const getAuthoritative = jest.fn<Promise<unknown>, [key: string]>(async () => null);
const setAuthoritative = jest.fn<Promise<void>, [key: string, value: unknown, ttlSeconds?: number]>(async () => undefined);
const delAuthoritative = jest.fn<Promise<void>, [key: string]>(async () => undefined);
const luaEvalAuthoritative = jest.fn<Promise<unknown>, [script: string, keys: string[], args: string[]]>(async () => 1);
const withKeyLock = jest.fn<Promise<unknown>, [key: string, fn: () => Promise<unknown>, options?: LockOptions]>(
  async (_key, fn) => fn(),
);

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => isRedisAvailable(),
  cache: {
    getAuthoritative: (key: string) => getAuthoritative(key),
    setAuthoritative: (key: string, value: unknown, ttlSeconds?: number) => setAuthoritative(key, value, ttlSeconds),
    delAuthoritative: (key: string) => delAuthoritative(key),
    luaEvalAuthoritative: (script: string, keys: string[], args: string[]) => luaEvalAuthoritative(script, keys, args),
    withKeyLock: (key: string, fn: () => Promise<unknown>, options?: LockOptions) => withKeyLock(key, fn, options),
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { chessStore } from '../socket/handlers/activities/chess-store';

const game = (extra: Record<string, unknown> = {}) =>
  ({ channelId: 'ch1', whiteUserId: 'u1', blackUserId: null, gameOver: false, ...extra } as never);

beforeEach(() => {
  chessStore._clearMemGames_TEST_ONLY();
  isRedisAvailable.mockReset(); isRedisAvailable.mockReturnValue(true);
  getAuthoritative.mockReset(); getAuthoritative.mockResolvedValue(null);
  setAuthoritative.mockReset(); setAuthoritative.mockResolvedValue(undefined);
  delAuthoritative.mockReset(); delAuthoritative.mockResolvedValue(undefined);
  luaEvalAuthoritative.mockReset(); luaEvalAuthoritative.mockResolvedValue(1);
  withKeyLock.mockReset();
  withKeyLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
});

afterAll(() => {
  chessStore._clearMemGames_TEST_ONLY();
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('the shared store owns the board while Redis is reachable', () => {
  it('reads and writes through the authoritative key with a bounded lifetime', async () => {
    getAuthoritative.mockResolvedValue(game());
    await expect(chessStore.get('ch1')).resolves.toEqual(game());
    expect(getAuthoritative).toHaveBeenCalledWith('chess:game:ch1');

    await chessStore.set('ch1', game());
    const [key, , ttl] = setAuthoritative.mock.calls[0];
    expect(key).toBe('chess:game:ch1');
    expect(ttl).toBe(60 * 60 * 4);
    // Paylasilan yazma basarili: surec-ici kopya BIRAKILMAZ.
    expect(chessStore._memGames.size).toBe(0);
  });

  it('deletes through the authoritative key', async () => {
    await chessStore.del('ch1');
    expect(delAuthoritative).toHaveBeenCalledWith('chess:game:ch1');
    expect(chessStore._memGames.size).toBe(0);
  });

  it('serialises mutations under a bounded per-channel lock', async () => {
    await expect(chessStore.withLock('ch1', async () => 'tamam')).resolves.toBe('tamam');
    const [key, , options] = withKeyLock.mock.calls[0];
    expect(key).toBe('chess-game:ch1');
    // `options` ISTEGE BAGLI bir parametredir; urun onu GECMEK ZORUNDA
    // oldugu icin varligi TESTIN IDDIASININ parcasidir.
    expect(present(options, 'kilit secenekleri').leaseSeconds).toBeGreaterThan(0);
  });
});

describe('ending the game is a race with exactly one winner', () => {
  it('reports success and clears the board when the CAS wins', async () => {
    luaEvalAuthoritative.mockResolvedValue(1);
    await expect(chessStore.markGameOver('ch1')).resolves.toBe(true);

    const [script] = luaEvalAuthoritative.mock.calls[0];
    // Oku-degistir-yaz TEK adimdadir; aksi hâlde iki cagri da kazanirdi.
    expect(script).toContain('gameOver');
    expect(delAuthoritative).toHaveBeenCalledWith('chess:game:ch1');
  });

  it('reports failure and touches nothing when the CAS loses', async () => {
    luaEvalAuthoritative.mockResolvedValue(0);
    await expect(chessStore.markGameOver('ch1')).resolves.toBe(false);
    // Kaybeden cagri tahtayi SILMEZ; kazanan zaten sildi.
    expect(delAuthoritative).not.toHaveBeenCalled();
  });

  it('propagates a Redis failure instead of quietly ending the game locally', async () => {
    luaEvalAuthoritative.mockRejectedValue(new Error('redis down'));
    await expect(chessStore.markGameOver('ch1')).rejects.toThrow('redis down');
  });
});

describe('claiming the black seat is a race with exactly one winner', () => {
  it('succeeds when the seat was free', async () => {
    luaEvalAuthoritative.mockResolvedValue(1);
    await expect(chessStore.claimBlack('ch1', 'u2')).resolves.toBe(true);
    const [, keys, args] = luaEvalAuthoritative.mock.calls[0] as [string, string[], string[]];
    expect(keys).toEqual(['chess:game:ch1']);
    expect(args[0]).toBe('u2');
  });

  it('fails when somebody already sat down', async () => {
    luaEvalAuthoritative.mockResolvedValue(0);
    await expect(chessStore.claimBlack('ch1', 'u3')).resolves.toBe(false);
  });

  it('propagates a Redis failure rather than seating two players', async () => {
    luaEvalAuthoritative.mockRejectedValue(new Error('redis down'));
    await expect(chessStore.claimBlack('ch1', 'u2')).rejects.toThrow('redis down');
  });
});

describe('with Redis configured but unreachable nothing falls back locally', () => {
  beforeEach(() => { isRedisAvailable.mockReturnValue(false); });

  it.each([
    ['get', () => chessStore.get('ch1')],
    ['set', () => chessStore.set('ch1', game())],
    ['delete', () => chessStore.del('ch1')],
    ['markGameOver', () => chessStore.markGameOver('ch1')],
    ['claimBlack', () => chessStore.claimBlack('ch1', 'u2')],
  ])('%s fails closed', async (operation, run) => {
    // Surec-ici bir kopya diger dugumun tahtasini bilmez; iki AYRI oyun olurdu.
    await expect(run()).rejects.toThrow(
      new RegExp(`Redis chess coordination unavailable during ${operation}`));
    expect(chessStore._memGames.size).toBe(0);
  });
});

describe('a Redis error on a plain read or write is propagated', () => {
  it.each([
    ['read', () => { getAuthoritative.mockRejectedValue(new Error('redis down')); return chessStore.get('ch1'); }],
    ['write', () => { setAuthoritative.mockRejectedValue(new Error('redis down')); return chessStore.set('ch1', game()); }],
    ['delete', () => { delAuthoritative.mockRejectedValue(new Error('redis down')); return chessStore.del('ch1'); }],
  ])('propagates a failed %s', async (_label, run) => {
    await expect(run()).rejects.toThrow('redis down');
  });
});
