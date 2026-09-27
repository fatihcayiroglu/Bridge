// server/tests/server-asset-repository-sparse-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SUNUCU VARLIK DEPOSU — SEYREK SATIRLAR VE LİSTELEME SIRASI
// ════════════════════════════════════════════════════════════════════════════
//
// Bu depo emoji, GIF, çıkartma, ses tahtası ve onboarding okumalarının TEK
// giriş noktasıdır. Çağıranların hepsi bir DİZİ döndüğünü varsayar ve doğrudan
// `.map`/`.length` çağırır — koleksiyon boş/eksik bir sonuç verdiğinde
// `undefined` dönmesi, sunucu ayarlarının tamamını 500 ile düşürürdü.
//
// Ayrıca ölçülen ikinci sözleşme SIRALAMADIR: ses tahtası listesi imleçle
// (keyset) sayfalanır ve sıralama anahtarı EKSİK alanlar içerebilir
// (hiç favorilenmemiş, hiç çalınmamış ses). Bu alanlar `undefined` olarak
// karşılaştırmaya girerse sıralama kararsızlaşır ve sayfalama satır atlar
// ya da aynı satırı iki kez verir.

'use strict';
process.env.NODE_ENV = 'test';

function collection() {
  return {
    find: jest.fn(), findOne: jest.fn(), insert: jest.fn(),
    update: jest.fn(), remove: jest.fn(),
  };
}

const serverEmojis = collection();
const serverGifs = collection();
const stickerPacks = collection();
const stickerPackItems = collection();
const soundboard = collection();
const soundboardUserStats = collection();
const serverTemplates = collection();
const onboardingCompletions = collection();
const serverOnboarding = collection();

const query = jest.fn();
const pool: { query?: typeof query } = {};

const dbMock: Record<string, unknown> = {
  _pool: pool,
  serverEmojis, serverGifs, stickerPacks, stickerPackItems,
  soundboard, soundboardUserStats, serverTemplates,
  onboardingCompletions, serverOnboarding,
};

const transactionClient = { query: jest.fn() };
const withTransaction = jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(transactionClient));

jest.mock('../db/loader', () => ({ __esModule: true, default: dbMock, ...dbMock }));
jest.mock('../db/postgres/transaction', () => ({
  withTransaction: (...args: unknown[]) => withTransaction(...args as [(c: unknown) => Promise<unknown>]),
}));

import { ServerAssets } from '../db/repositories';
import { BUILTIN_SOUNDBOARD_SOUNDS } from '../lib/soundboardCatalog';

/** A chainable stand-in for the collection query builder. */
function chain(result: unknown) {
  const builder: Record<string, unknown> = {};
  builder.sort = () => builder;
  builder.limit = () => result;
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}
/** A builder whose `.sort()` step yields nothing at all. */
function sortYieldsNothing() {
  return { sort: () => undefined };
}
/** A builder whose bounded `.limit()` step yields nothing at all. */
function limitYieldsNothing() {
  const builder: Record<string, unknown> = {};
  builder.sort = () => builder;
  builder.limit = () => undefined;
  return builder;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete pool.query;
  for (const c of [serverEmojis, serverGifs, stickerPacks, stickerPackItems,
    soundboard, soundboardUserStats, serverTemplates, onboardingCompletions, serverOnboarding]) {
    c.find.mockReturnValue(chain([]));
    c.findOne.mockResolvedValue(null);
    c.insert.mockResolvedValue(undefined);
    c.update.mockResolvedValue({ updated: 1 });
    c.remove.mockResolvedValue({ deleted: 1 });
  }
  soundboardUserStats.find.mockResolvedValue([]);
  soundboard.find.mockReturnValue(chain([]));
  transactionClient.query.mockResolvedValue({ rows: [] });
});

describe('list reads never hand a caller something that is not a list', () => {
  const emptyResultCases: Array<[string, () => Promise<unknown>, () => void]> = [
    ['emojis', () => ServerAssets.findEmojis('s1'), () => serverEmojis.find.mockReturnValue(undefined)],
    ['sorted emojis', () => ServerAssets.findEmojisSorted('s1'), () => serverEmojis.find.mockReturnValue(sortYieldsNothing())],
    ['gifs', () => ServerAssets.findGifs('s1'), () => serverGifs.find.mockReturnValue(undefined)],
    ['gifs for several servers', () => ServerAssets.findGifsByServerIds(['s1', 's2']), () => serverGifs.find.mockReturnValue(undefined)],
    ['sticker packs', () => ServerAssets.findStickerPacksByServer('s1'), () => stickerPacks.find.mockReturnValue(sortYieldsNothing())],
    ['sticker items', () => ServerAssets.findStickerItemsByPackIds(['p1']), () => stickerPackItems.find.mockReturnValue(sortYieldsNothing())],
    ['sounds', () => ServerAssets.findSounds('s1'), () => soundboard.find.mockReturnValue(limitYieldsNothing())],
    ['sorted sounds', () => ServerAssets.findSoundsSorted('s1'), () => soundboard.find.mockReturnValue(limitYieldsNothing())],
    ['templates', () => ServerAssets.findTemplates(), () => serverTemplates.find.mockReturnValue(undefined)],
    ['onboarding completions', () => ServerAssets.findOnboardingCompletions('s1'), () => onboardingCompletions.find.mockReturnValue(undefined)],
  ];

  for (const [name, run, arrange] of emptyResultCases) {
    it(`${name}: an absent result set reads as an empty list`, async () => {
      arrange();
      await expect(run()).resolves.toEqual([]);
    });
  }

  it('an empty id list short-circuits without querying at all', async () => {
    await expect(ServerAssets.findGifsByServerIds([])).resolves.toEqual([]);
    await expect(ServerAssets.findStickerItemsByPackIds([])).resolves.toEqual([]);
    expect(serverGifs.find).not.toHaveBeenCalled();
    expect(stickerPackItems.find).not.toHaveBeenCalled();
  });

  it('a single server id is accepted where a list is expected', async () => {
    serverGifs.find.mockReturnValue(chain([{ _id: 'g1' }]));
    await expect(ServerAssets.findGifsByServerIds('s1')).resolves.toEqual([{ _id: 'g1' }]);
    expect(serverGifs.find).toHaveBeenCalledWith({ serverId: { $in: ['s1'] } });
  });

  it('the compatibility sound reads stay bounded whatever limit is asked for', async () => {
    const limits: Array<[number, number]> = [[0, 100], [Number.NaN, 100], [5_000, 100], [7.9, 7], [-3, 1]];
    for (const [asked, expected] of limits) {
      const limit = jest.fn(() => []);
      soundboard.find.mockReturnValue({ sort: () => ({ limit }), limit });
      await ServerAssets.findSoundsSorted('s1', asked);
      expect(limit).toHaveBeenCalledWith(expected);
    }
  });
});

describe('soundboard paging orders sparse rows deterministically', () => {
  const BUILTIN_IDS = BUILTIN_SOUNDBOARD_SOUNDS.map(sound => sound._id);

  function page(view: 'all' | 'server' | 'global' | 'favorites' | 'recent' | 'frequent', limit = 50) {
    return ServerAssets.listSoundsPage({
      serverId: 's1', userId: 'u1', limit, query: '', view, cursor: null,
    });
  }

  it('never-favorited rows sort below favorited ones instead of comparing as undefined', async () => {
    soundboard.find.mockReturnValue(chain([
      { _id: 'a', name: 'A', url: 'a', createdAt: 1 },
      { _id: 'b', name: 'B', url: 'b', createdAt: 2 },
    ]));
    soundboardUserStats.find.mockResolvedValue([
      { soundId: 'a', favorite: true, favoritedAt: 500, playCount: 0, lastPlayedAt: null },
      { soundId: 'b', favorite: true, favoritedAt: null, playCount: 0, lastPlayedAt: null },
    ]);

    const result = await page('favorites');
    expect(result.items.map(item => item._id)).toEqual(['a', 'b']);
  });

  it('never-played rows sort below played ones in the recent view', async () => {
    soundboard.find.mockReturnValue(chain([
      { _id: 'a', name: 'A', url: 'a', createdAt: 1 },
      { _id: 'b', name: 'B', url: 'b', createdAt: 2 },
    ]));
    soundboardUserStats.find.mockResolvedValue([
      { soundId: 'a', favorite: false, favoritedAt: null, playCount: 1, lastPlayedAt: null },
      { soundId: 'b', favorite: false, favoritedAt: null, playCount: 2, lastPlayedAt: 900 },
    ]);

    const recent = await page('recent');
    expect(recent.items.map(item => item._id)).toEqual(['b', 'a']);

    // The frequent view ranks by play count first and uses last-played only to
    // break ties, so a missing timestamp must not reorder the counts.
    const frequent = await page('frequent');
    expect(frequent.items.map(item => item._id)).toEqual(['b', 'a']);
  });

  it('the global view returns only the built-in catalogue', async () => {
    soundboard.find.mockReturnValue(chain([{ _id: 'srv', name: 'Server sound', url: 'u', createdAt: 1 }]));
    const result = await page('global');
    // Order is the keyset order (newest first), not catalogue order; what the
    // view guarantees is the SET of rows and that none of them is server-scoped.
    expect(result.items.map(item => item._id).sort()).toEqual([...BUILTIN_IDS].sort());
    expect(result.items.every(item => item.scope === 'global')).toBe(true);
  });

  it('the server view returns only uploaded sounds', async () => {
    soundboard.find.mockReturnValue(chain([{ _id: 'srv', name: 'Server sound', url: 'u', createdAt: 1 }]));
    const result = await page('server');
    expect(result.items.map(item => item._id)).toEqual(['srv']);
    expect(result.items[0]!.category).toBe('Server');
  });

  it('a page that is exactly full without more rows advertises no cursor', async () => {
    soundboard.find.mockReturnValue(chain([]));
    const result = await page('global', BUILTIN_IDS.length);
    expect(result.items).toHaveLength(BUILTIN_IDS.length);
    expect(result.nextCursor).toBeNull();
  });

  it('a truncated page hands back a cursor that continues without repeating', async () => {
    soundboard.find.mockReturnValue(chain([]));
    const first = await page('global', 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    const second = await ServerAssets.listSoundsPage({
      serverId: 's1', userId: 'u1', limit: 50, query: '', view: 'global', cursor: decoded,
    });
    expect(second.items.map(item => item._id)).not.toContain(first.items[0]!._id);
  });

  it('a text query filters case-insensitively across both scopes', async () => {
    soundboard.find.mockReturnValue(chain([{ _id: 'srv', name: 'Airhorn Deluxe', url: 'u', createdAt: 1 }]));
    const result = await ServerAssets.listSoundsPage({
      serverId: 's1', userId: 'u1', limit: 50, query: 'AIRHORN', view: 'all', cursor: null,
    });
    expect(result.items.map(item => item._id)).toContain('srv');
  });
});

describe('soundboard mutations', () => {
  it('an update that changed nothing returns null instead of a stale row', async () => {
    soundboard.update.mockResolvedValue({ updated: 0 });
    await expect(ServerAssets.updateSound('s-1', 'srv-1', { name: 'x' })).resolves.toBeNull();
    expect(soundboard.findOne).not.toHaveBeenCalled();
  });

  it('an update whose result omits the counter is treated as no change', async () => {
    soundboard.update.mockResolvedValue({});
    await expect(ServerAssets.updateSound('s-1', 'srv-1', { name: 'x' })).resolves.toBeNull();
  });

  it('a successful update re-reads the row scoped to the same server', async () => {
    soundboard.update.mockResolvedValue({ updated: 1 });
    soundboard.findOne.mockResolvedValue({ _id: 's-1', name: 'x' });
    await expect(ServerAssets.updateSound('s-1', 'srv-1', { name: 'x' })).resolves.toEqual({ _id: 's-1', name: 'x' });
    expect(soundboard.findOne).toHaveBeenCalledWith({ _id: 's-1', serverId: 'srv-1' });
  });

  it('un-favoriting clears the timestamp rather than leaving a stale one', async () => {
    soundboardUserStats.findOne.mockResolvedValue(null);
    await ServerAssets.setSoundFavorite('s-1', 'u1', 'srv-1', false);
    expect(soundboardUserStats.insert).toHaveBeenCalledWith(
      expect.objectContaining({ favorite: false, favoritedAt: null, playCount: 0, lastPlayedAt: null }));
  });

  it('favoriting an existing row stamps the moment it happened', async () => {
    soundboardUserStats.findOne.mockResolvedValue({ userId: 'u1', soundId: 's-1' });
    await ServerAssets.setSoundFavorite('s-1', 'u1', 'srv-1', true);
    const [, modifier] = soundboardUserStats.update.mock.calls[0] as [unknown, { $set: Record<string, unknown> }];
    expect(modifier.$set.favorite).toBe(true);
    expect(modifier.$set.favoritedAt).toEqual(expect.any(Number));
    expect(soundboardUserStats.insert).not.toHaveBeenCalled();
  });

  it('deleting a sound also drops the per-user state that referenced it', async () => {
    soundboard.remove.mockResolvedValue({ deleted: 1 });
    await ServerAssets.deleteSound('s-1', 'srv-1');
    expect(soundboardUserStats.remove).toHaveBeenCalledWith({ soundId: 's-1' });
  });

  it('deleting a sound that was not there leaves other users state alone', async () => {
    soundboard.remove.mockResolvedValue({ deleted: 0 });
    await ServerAssets.deleteSound('s-1', 'srv-1');
    expect(soundboardUserStats.remove).not.toHaveBeenCalled();
  });

  it('a delete result without a counter is treated as nothing deleted', async () => {
    soundboard.remove.mockResolvedValue({});
    await ServerAssets.deleteSound('s-1', 'srv-1');
    expect(soundboardUserStats.remove).not.toHaveBeenCalled();
  });
});

describe('sticker pack creation is one transaction', () => {
  it('writes the pack and every item, defaulting absent tags to an empty array', async () => {
    await ServerAssets.createStickerPack({
      packId: 'p1', serverId: 's1', name: 'Pack', description: '', authorId: 'u1', createdAt: 5,
      items: [
        { id: 'i1', name: 'A', url: 'a', width: 1, height: 1, tags: ['x'] },
        { id: 'i2', name: 'B', url: 'b', width: 2, height: 2 },
      ] as never,
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const inserts = transactionClient.query.mock.calls;
    expect(String(inserts[0]![0])).toContain('INSERT INTO sticker_packs');
    // Position comes from the array index, so upload order is preserved.
    expect((inserts[1]![1] as unknown[])[7]).toBe(0);
    expect((inserts[2]![1] as unknown[])[7]).toBe(1);
    expect((inserts[1]![1] as unknown[])[4]).toBe(JSON.stringify(['x']));
    expect((inserts[2]![1] as unknown[])[4]).toBe(JSON.stringify([]));
  });

  it('a pack with no items still writes the pack row', async () => {
    await ServerAssets.createStickerPack({
      packId: 'p2', serverId: 's1', name: 'Empty', description: '', authorId: 'u1', createdAt: 5, items: [],
    } as never);
    expect(transactionClient.query).toHaveBeenCalledTimes(1);
  });
});

describe('onboarding completion is claimed exactly once', () => {
  it('a PostgreSQL insert that inserted one row is a successful claim', async () => {
    pool.query = query;
    query.mockResolvedValue({ rowCount: 1 });
    await expect(ServerAssets.claimOnboardingCompletion({
      _id: 'u1_s1', serverId: 's1', userId: 'u1', completedAt: 5, answers: '{}',
    })).resolves.toBe(true);
    expect(String(query.mock.calls[0]![0])).toContain('ON CONFLICT ("serverId","userId") DO NOTHING');
  });

  it('a conflicting insert is a lost race, not a second completion', async () => {
    pool.query = query;
    query.mockResolvedValue({ rowCount: 0 });
    await expect(ServerAssets.claimOnboardingCompletion({
      _id: 'u1_s1', serverId: 's1', userId: 'u1', completedAt: 5, answers: '{}',
    })).resolves.toBe(false);
  });

  it('a driver that omits the row count is treated as a lost race', async () => {
    pool.query = query;
    query.mockResolvedValue({});
    await expect(ServerAssets.claimOnboardingCompletion({
      _id: 'u1_s1', serverId: 's1', userId: 'u1', completedAt: 5, answers: '{}',
    })).resolves.toBe(false);
    expect(onboardingCompletions.insert).not.toHaveBeenCalled();
  });

  it('the collection fallback refuses a duplicate completion', async () => {
    onboardingCompletions.findOne.mockResolvedValue({ _id: 'u1_s1' });
    await expect(ServerAssets.claimOnboardingCompletion({
      _id: 'u1_s1', serverId: 's1', userId: 'u1', completedAt: 5, answers: '{}',
    })).resolves.toBe(false);
    expect(onboardingCompletions.insert).not.toHaveBeenCalled();
  });
});
