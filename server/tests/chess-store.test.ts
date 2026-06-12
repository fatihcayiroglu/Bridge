// server/tests/chess-store.test.ts
// Sprint 87: chessStore unit testleri.
//
// Kapsam:
//   - get / set / del (in-memory fallback — Redis olmadan)
//   - markGameOver: ilk çağrı true, ikinci çağrı false (idempotent)
//   - markGameOver: gameOver=true olan oyun için false döner
//   - claimBlack: ilk çağrı true, ikinci çağrı false (race condition koruması)
//   - claimBlack: blackUserId dolu ise false döner
//   - TTL / key prefix (dolaylı — key izolasyonu testi)
//   - Lua eval yolu: Redis mock'ı ile çağrı doğrulaması
//
// Not: Test ortamında Redis yoktur; tüm testler in-memory fallback üzerinden çalışır.
// Lua eval yolu için redisAdapter mock'lanır.

import { chessStore } from '../socket/handlers/activities/chess-store';
import type { GameState } from '../socket/handlers/activities/chess-types';

// ── Yardımcılar ──────────────────────────────────────────────────────────────

function makeGame(overrides: Partial<GameState> = {}): GameState {
  return {
    board:       Array.from({ length: 8 }, () => Array(8).fill(null)),
    turn:        'w',
    castling:    { wK: true, wQ: true, bK: true, bQ: true },
    enPassant:   null,
    halfmove:    0,
    moveHistory: [],
    gameOver:    false,
    result:      null,
    whiteUserId: 'userA',
    blackUserId: null,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  chessStore._clearMemGames_TEST_ONLY();
});

// ── get / set / del ───────────────────────────────────────────────────────────

describe('get / set / del (in-memory)', () => {
  it('var olmayan channelId için null döner', async () => {
    const result = await chessStore.get('ch-nonexistent');
    expect(result).toBeNull();
  });

  it('set → get round-trip çalışır', async () => {
    const game = makeGame({ whiteUserId: 'alice' });
    await chessStore.set('ch-rtt', game);
    const fetched = await chessStore.get('ch-rtt');
    expect(fetched).not.toBeNull();
    expect(fetched!.whiteUserId).toBe('alice');
  });

  it('del sonrası get null döner', async () => {
    await chessStore.set('ch-del', makeGame());
    await chessStore.del('ch-del');
    expect(await chessStore.get('ch-del')).toBeNull();
  });

  it('farklı channelId\'ler izole çalışır', async () => {
    await chessStore.set('ch-a', makeGame({ whiteUserId: 'alice' }));
    await chessStore.set('ch-b', makeGame({ whiteUserId: 'bob' }));
    const a = await chessStore.get('ch-a');
    const b = await chessStore.get('ch-b');
    expect(a!.whiteUserId).toBe('alice');
    expect(b!.whiteUserId).toBe('bob');
  });

  it('set aynı channelId\'yi günceller (upsert)', async () => {
    await chessStore.set('ch-upsert', makeGame({ turn: 'w' }));
    await chessStore.set('ch-upsert', makeGame({ turn: 'b' }));
    const result = await chessStore.get('ch-upsert');
    expect(result!.turn).toBe('b');
  });
});

// ── markGameOver ──────────────────────────────────────────────────────────────

describe('markGameOver (in-memory)', () => {
  it('aktif oyun için true döner ve oyun silinir', async () => {
    await chessStore.set('ch-mgo-1', makeGame());
    const ok = await chessStore.markGameOver('ch-mgo-1');
    expect(ok).toBe(true);
    // Oyun in-memory'den silinmiş olmalı
    expect(await chessStore.get('ch-mgo-1')).toBeNull();
  });

  it('var olmayan oyun için false döner', async () => {
    const ok = await chessStore.markGameOver('ch-mgo-noexist');
    expect(ok).toBe(false);
  });

  it('zaten gameOver=true olan oyun için false döner', async () => {
    await chessStore.set('ch-mgo-already', makeGame({ gameOver: true }));
    const ok = await chessStore.markGameOver('ch-mgo-already');
    expect(ok).toBe(false);
  });

  it('iki ardışık çağrı: ilki true, ikincisi false (idempotent)', async () => {
    await chessStore.set('ch-mgo-race', makeGame());
    const first  = await chessStore.markGameOver('ch-mgo-race');
    const second = await chessStore.markGameOver('ch-mgo-race');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

// ── claimBlack ────────────────────────────────────────────────────────────────

describe('claimBlack (in-memory)', () => {
  it('blackUserId null iken ilk katılan userId\'yi yazar ve true döner', async () => {
    await chessStore.set('ch-cb-1', makeGame({ blackUserId: null }));
    const ok = await chessStore.claimBlack('ch-cb-1', 'userB');
    expect(ok).toBe(true);
    const game = await chessStore.get('ch-cb-1');
    expect(game!.blackUserId).toBe('userB');
  });

  it('blackUserId dolu iken false döner (siyahı değiştirmez)', async () => {
    await chessStore.set('ch-cb-taken', makeGame({ blackUserId: 'userB' }));
    const ok = await chessStore.claimBlack('ch-cb-taken', 'userC');
    expect(ok).toBe(false);
    const game = await chessStore.get('ch-cb-taken');
    expect(game!.blackUserId).toBe('userB'); // değişmedi
  });

  it('var olmayan oyun için false döner', async () => {
    const ok = await chessStore.claimBlack('ch-cb-noexist', 'userX');
    expect(ok).toBe(false);
  });

  it('eş zamanlı iki claimBlack çağrısı tek kazanan belirler', async () => {
    // JS single-threaded olduğundan eş zamanlılık simüle edilemez;
    // ancak sıralı iki çağrının doğru davrandığını doğrularız.
    await chessStore.set('ch-cb-race', makeGame({ blackUserId: null }));
    const r1 = await chessStore.claimBlack('ch-cb-race', 'userB');
    const r2 = await chessStore.claimBlack('ch-cb-race', 'userC');
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    const game = await chessStore.get('ch-cb-race');
    expect(game!.blackUserId).toBe('userB');
  });
});

// ── Redis mock ile Lua eval yolu ─────────────────────────────────────────────

describe('markGameOver / claimBlack (Redis mock)', () => {
  // redisAdapter modülünü mock'la
  const mockLuaEval = jest.fn();
  const mockGet     = jest.fn();
  const mockSet     = jest.fn();
  const mockDel     = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    mockLuaEval.mockReset();
    mockGet.mockReset();
    mockSet.mockReset();
    mockDel.mockReset();
  });

  it('Redis mevcut iken markGameOver luaEval=1 → true döner', async () => {
    jest.mock('../lib/redisAdapter', () => ({
      isRedisAvailable: () => true,
      cache: {
        luaEval: mockLuaEval.mockResolvedValue(1),
        del:     mockDel.mockResolvedValue(undefined),
        get:     mockGet,
        set:     mockSet,
      },
    }));

    // Mock modülü temiz import
    const { chessStore: store } = await import('../socket/handlers/activities/chess-store');
    store._clearMemGames_TEST_ONLY();

    const ok = await store.markGameOver('ch-redis-mgo');
    expect(ok).toBe(true);
    expect(mockLuaEval).toHaveBeenCalledTimes(1);
    expect(mockDel).toHaveBeenCalledTimes(1);

    jest.unmock('../lib/redisAdapter');
  });

  it('Redis mevcut iken markGameOver luaEval=0 → false döner', async () => {
    jest.mock('../lib/redisAdapter', () => ({
      isRedisAvailable: () => true,
      cache: {
        luaEval: mockLuaEval.mockResolvedValue(0),
        del:     mockDel.mockResolvedValue(undefined), // luaEval=0 → del çağrılmaz ama mock hazır
        get:     mockGet,
        set:     mockSet,
      },
    }));

    const { chessStore: store } = await import('../socket/handlers/activities/chess-store');
    store._clearMemGames_TEST_ONLY();

    const ok = await store.markGameOver('ch-redis-mgo-0');
    expect(ok).toBe(false);
    expect(mockDel).not.toHaveBeenCalled();

    jest.unmock('../lib/redisAdapter');
  });

  it('Redis mevcut iken claimBlack luaEval=1 → true döner', async () => {
    jest.mock('../lib/redisAdapter', () => ({
      isRedisAvailable: () => true,
      cache: {
        luaEval: mockLuaEval.mockResolvedValue(1),
        del:     mockDel.mockResolvedValue(undefined),
        get:     mockGet,
        set:     mockSet,
      },
    }));

    const { chessStore: store } = await import('../socket/handlers/activities/chess-store');
    store._clearMemGames_TEST_ONLY();

    const ok = await store.claimBlack('ch-redis-cb', 'userB');
    expect(ok).toBe(true);
    expect(mockLuaEval).toHaveBeenCalledTimes(1);

    jest.unmock('../lib/redisAdapter');
  });

  it('luaEval hata fırlatırsa in-memory fallback devreye girer', async () => {
    jest.mock('../lib/redisAdapter', () => ({
      isRedisAvailable: () => true,
      cache: {
        luaEval: mockLuaEval.mockRejectedValue(new Error('Redis bağlantı hatası')),
        del:     mockDel.mockResolvedValue(undefined),
        get:     mockGet,
        set:     mockSet,
      },
    }));

    const { chessStore: store } = await import('../socket/handlers/activities/chess-store');
    store._clearMemGames_TEST_ONLY();

    // In-memory'de oyun yok → fallback false dönmeli
    const ok = await store.markGameOver('ch-redis-err');
    expect(ok).toBe(false);

    jest.unmock('../lib/redisAdapter');
  });
});

// ── _clearMemGames_TEST_ONLY ──────────────────────────────────────────────────

describe('_clearMemGames_TEST_ONLY', () => {
  it('tüm in-memory oyunları temizler', async () => {
    await chessStore.set('ch-clear-1', makeGame());
    await chessStore.set('ch-clear-2', makeGame());
    chessStore._clearMemGames_TEST_ONLY();
    expect(await chessStore.get('ch-clear-1')).toBeNull();
    expect(await chessStore.get('ch-clear-2')).toBeNull();
  });
});
