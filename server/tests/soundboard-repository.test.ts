process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
let db = createMockDb({ withPgPool: true });
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb({ withPgPool: true });
});
jest.mock('../db/loader', () => require('../db/index'));

import ServerAssets, {
  decodeSoundboardCursor,
  encodeSoundboardCursor,
  type SoundboardListView,
} from '../db/repositories/ServerAssetRepository';

beforeEach(() => {
  db = createMockDb({ withPgPool: true });
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
});

async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { return await fn(); }
  finally { process.env.NODE_ENV = previous; }
}

describe('soundboard production repository path', () => {
  it('uses one bounded keyset query, joins stats/catalog, escapes literal search, and emits an opaque continuation', async () => {
    db._pool!.query.mockResolvedValueOnce({
      rows: [
        { _id: 'global:notify', name: 'Notify 100%_', emoji: '✨', url: 'bridge-sound:notify', category: 'Bridge', scope: 'global', createdAt: 0, favorite: true, playCount: '4', favoritedAt: '100', lastPlayedAt: '90', scopeRank: 1 },
        { _id: 'server-1', name: 'Server', emoji: '🔊', url: '/uploads/soundboard/server.wav', category: 'Server', scope: 'server', createdAt: '80', favorite: false, playCount: '0', scopeRank: 0 },
      ],
    });
    const page = await asProduction(() => ServerAssets.listSoundsPage({
      serverId: 'srv', userId: 'usr', limit: 1, query: '100%_', view: 'all', cursor: null,
    }));
    expect(page.items).toEqual([expect.objectContaining({
      _id: 'global:notify', scope: 'global', favorite: true, playCount: 4, favoritedAt: 100,
    })]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(decodeSoundboardCursor(page.nextCursor!, 'all', '100%_')).toEqual({
      view: 'all', query: '100%_', key: [1, 0, 'global:notify'],
    });
    const [sql, params] = db._pool!.query.mock.calls[0]!;
    expect(String(sql)).toContain('WITH assets AS');
    expect(String(sql)).toContain('LEFT JOIN soundboard_user_stats');
    expect(String(sql)).toContain('::BIGINT');
    expect(String(sql)).toContain('::DOUBLE PRECISION');
    expect(String(sql)).toMatch(/LIMIT \$\d+/);
    expect(params).toContain('%100\\%\\_%');
    expect(params.at(-1)).toBe(2);
  });

  it.each([
    ['server', [0, 50, 's1'], `e.scope = 'server'`, '"scopeRank"'],
    ['global', [1, 0, 'global:pop'], `e.scope = 'global'`, '"scopeRank"'],
    ['favorites', [100, 0, 's1'], 'e.favorite = TRUE', '"favoritedAt"'],
    ['recent', [90, 0, 's1'], 'e."playCount" > 0', '"lastPlayedAt"'],
    ['frequent', [8, 90, 's1'], 'e."playCount" > 0', '"playCount"'],
  ] as Array<[SoundboardListView, [number, number, string], string, string]>) (
    'builds deterministic %s keyset predicates',
    async (view, key, filter, ordering) => {
      db._pool!.query.mockResolvedValueOnce({ rows: [] });
      await asProduction(() => ServerAssets.listSoundsPage({
        serverId: 'srv', userId: 'usr', limit: 48, query: '', view,
        cursor: { view, query: '', key },
      }));
      const [sql, params] = db._pool!.query.mock.calls[0]!;
      expect(String(sql)).toContain(filter);
      expect(String(sql)).toContain(ordering);
      expect(String(sql)).toContain(' < (');
      expect(params.at(-1)).toBe(49);
    },
  );

  it('atomically upserts favorite and play state without read/modify/write races', async () => {
    db._pool!.query
      .mockResolvedValueOnce({ rows: [{ favorite: true, favoritedAt: 10, playCount: '0', lastPlayedAt: null }] })
      .mockResolvedValueOnce({ rows: [{ playCount: '3', lastPlayedAt: 20 }] });
    const favorite = await asProduction(() => ServerAssets.setSoundFavorite('snd', 'usr', 'srv', true));
    const played = await asProduction(() => ServerAssets.recordSoundPlay('snd', 'usr', 'srv'));
    expect(favorite).toEqual(expect.objectContaining({ favorite: true }));
    expect(played).toEqual(expect.objectContaining({ playCount: '3' }));
    expect(String(db._pool!.query.mock.calls[0]![0])).toContain('ON CONFLICT ("userId", "soundId") DO UPDATE');
    expect(String(db._pool!.query.mock.calls[1]![0])).toContain('soundboard_user_stats."playCount" + 1');
  });

  it('deletes sound and user stats in one transaction and preserves the primary error on rollback failure', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({});
    const release = jest.fn();
    db._pool!.connect.mockResolvedValueOnce({ query, release });
    const deleted = await asProduction(() => ServerAssets.deleteSound('snd', 'srv'));
    expect(deleted).toEqual({ deleted: 1 });
    expect(query.mock.calls.map(call => String(call[0]))).toEqual([
      'BEGIN',
      'DELETE FROM soundboard WHERE _id = $1 AND "serverId" = $2',
      'DELETE FROM soundboard_user_stats WHERE "soundId" = $1',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalled();

    const canonical = new Error('delete failed');
    const failingQuery = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(canonical)
      .mockRejectedValueOnce(new Error('rollback transport failed'));
    const failingRelease = jest.fn();
    db._pool!.connect.mockResolvedValueOnce({ query: failingQuery, release: failingRelease });
    await expect(asProduction(() => ServerAssets.deleteSound('snd', 'srv'))).rejects.toBe(canonical);
    expect(failingQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(failingRelease).toHaveBeenCalled();
  });
});

describe('soundboard compatibility repository reads', () => {
  it('persists a first play and increments an existing per-user play record', async () => {
    const first = await ServerAssets.recordSoundPlay('snd', 'usr', 'srv');
    expect(first).toEqual(expect.objectContaining({
      soundId: 'snd', userId: 'usr', serverId: 'srv', playCount: 1,
    }));
    expect(first?.lastPlayedAt).toEqual(expect.any(Number));

    const second = await ServerAssets.recordSoundPlay('snd', 'usr', 'srv');
    expect(second).toEqual(expect.objectContaining({
      soundId: 'snd', userId: 'usr', serverId: 'srv', playCount: 2,
    }));
    expect(Number(second?.lastPlayedAt)).toBeGreaterThanOrEqual(Number(first?.lastPlayedAt));
    await expect(db.soundboardUserStats.count({ userId: 'usr', soundId: 'snd' })).resolves.toBe(1);
  });

  it('bounds legacy helpers even when a caller requests an unsafe count', async () => {
    await Promise.all(Array.from({ length: 150 }, (_, i) => db.soundboard.insert({
      _id: `s-${i}`, serverId: 'srv', name: `Sound ${i}`, url: `/uploads/soundboard/${i}.wav`, createdAt: i,
    })));
    await expect(ServerAssets.findSounds('srv', 10_000)).resolves.toHaveLength(100);
    await expect(ServerAssets.findSoundsSorted('srv', -50)).resolves.toHaveLength(1);
    await expect(ServerAssets.findSounds('srv', Number.NaN)).resolves.toHaveLength(100);
  });
});

describe('soundboard cursor validation', () => {
  it('rejects corruption, wrong version/context, unsafe keys and oversized tokens', () => {
    const valid = encodeSoundboardCursor({ view: 'recent', query: 'bell', key: [1, 0, 'sound'] });
    expect(decodeSoundboardCursor(valid, 'recent', 'bell').key).toEqual([1, 0, 'sound']);
    for (const token of [
      '***',
      Buffer.from('{bad').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 2, view: 'recent', query: 'bell', key: [1, 0, 'sound'] })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, view: 'recent', query: 'bell', key: [Infinity, 0, 'sound'] })).toString('base64url'),
      'a'.repeat(513),
    ]) expect(() => decodeSoundboardCursor(token, 'recent', 'bell')).toThrow('Invalid soundboard cursor');
    expect(() => decodeSoundboardCursor(valid, 'frequent', 'bell')).toThrow('Invalid soundboard cursor');
    expect(() => decodeSoundboardCursor(valid, 'recent', 'other')).toThrow('Invalid soundboard cursor');
  });
});
