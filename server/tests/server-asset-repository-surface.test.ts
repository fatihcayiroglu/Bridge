// server/tests/server-asset-repository-surface.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// db/repositories/ServerAssetRepository.ts — SUNUCU VARLIK SAHİPLİĞİ
// ════════════════════════════════════════════════════════════════════════════
// Bu depo emoji, GIF, sticker paketi, soundboard, şablon ve onboarding
// satırlarının TEK kanonik sahibidir. Buradaki her sorgu bir KİRACI SINIRIDIR:
// `serverId` düşerse bir sunucunun üyesi başka sunucunun varlığını okuyabilir
// veya silebilir (yatay yetki yükselmesi).
//
// Depo iki yolla çalışır: üretimde PostgreSQL, birim testlerinde in-memory
// adapter. `soundboard-repository.test.ts` PG yolunun ana senaryolarını ölçer;
// bu dosya, ölçülmemiş kalan sahiplik/varsayılan/geri düşüş dallarını kapatır.
process.env.NODE_ENV = 'test';

import { createMockDb, requireDoc } from './helpers/mockDb';
let db = createMockDb({ withPgPool: true });
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb({ withPgPool: true });
});
jest.mock('../db/loader', () => require('../db/index'));

import ServerAssets, {
  decodeSoundboardCursor,
  encodeSoundboardCursor,
} from '../db/repositories/ServerAssetRepository';

beforeEach(() => {
  db = createMockDb({ withPgPool: true });
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
});

/**
 * PostgreSQL havuzunu KANONİK modül nesnesinden kaldırır. Yerel `db`
 * değişkeninden silmek yetmez: depo, `db/loader` modül nesnesini okur.
 */
function withoutPgPool(): void {
  const loader = require('../db/loader') as Record<string, unknown>;
  delete loader._pool;
  delete (require('../db/index') as Record<string, unknown>)._pool;
  delete (db as unknown as Record<string, unknown>)._pool;
}

async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { return await fn(); }
  finally { process.env.NODE_ENV = previous; }
}

describe('server emoji ownership', () => {
  it('scopes every read, update and delete to the owning server', async () => {
    const mine = await ServerAssets.insertEmoji({ serverId: 's1', name: 'wave', url: '/e/1.png' });
    const theirs = await ServerAssets.insertEmoji({ serverId: 's2', name: 'wave', url: '/e/2.png' });
    expect(mine._id).not.toBe(theirs._id);
    expect(mine.createdAt).toEqual(expect.any(Number));

    expect(await ServerAssets.findEmojis('s1')).toHaveLength(1);
    expect(await ServerAssets.findEmojisSorted('s1')).toEqual([expect.objectContaining({ name: 'wave' })]);
    expect(await ServerAssets.findEmoji(mine._id)).toEqual(expect.objectContaining({ serverId: 's1' }));
    expect(await ServerAssets.findEmojiByIdAndServer(mine._id, 's1')).not.toBeNull();
    // KİRACI SINIRI: doğru kimlik + YANLIŞ sunucu asla çözülmez.
    expect(await ServerAssets.findEmojiByIdAndServer(mine._id, 's2')).toBeNull();
    expect(await ServerAssets.findEmojiByServerAndName('s1', 'wave')).toEqual(expect.objectContaining({ _id: mine._id }));
    expect(await ServerAssets.findEmojiByServerAndName('s3', 'wave')).toBeNull();

    expect(await ServerAssets.updateEmoji(mine._id, 's2', { name: 'stolen' })).toEqual({ updated: 0 });
    expect(await ServerAssets.updateEmoji(mine._id, 's1', { name: 'renamed' })).toEqual({ updated: 1 });
    expect((await ServerAssets.findEmoji(mine._id))!.name).toBe('renamed');

    expect(await ServerAssets.deleteEmoji(mine._id, 's2')).toEqual({ deleted: 0 });
    expect(await ServerAssets.deleteEmoji(mine._id, 's1')).toEqual({ deleted: 1 });
    expect(await ServerAssets.findEmojis('s2')).toHaveLength(1);
  });

  it('bulk server deletion removes only the deleted server rows', async () => {
    await ServerAssets.insertEmoji({ serverId: 's1', name: 'a', url: '/a.png' });
    await ServerAssets.insertEmoji({ serverId: 's1', name: 'b', url: '/b.png' });
    await ServerAssets.insertEmoji({ serverId: 's2', name: 'c', url: '/c.png' });
    expect(await ServerAssets.deleteEmojisByServer('s1')).toEqual({ deleted: 2 });
    expect(await ServerAssets.findEmojis('s1')).toEqual([]);
    expect(await ServerAssets.findEmojis('s2')).toHaveLength(1);
  });
});

describe('server GIF ownership', () => {
  it('accepts a single id or a list and never resolves an empty request into a full scan', async () => {
    const one = await ServerAssets.insertGif({ serverId: 's1', url: '/g/1.gif' });
    await ServerAssets.insertGif({ serverId: 's2', url: '/g/2.gif' });

    expect(await ServerAssets.findGifs('s1')).toHaveLength(1);
    expect(await ServerAssets.findGifsByServerIds('s1')).toEqual([expect.objectContaining({ serverId: 's1' })]);
    expect(await ServerAssets.findGifsByServerIds(['s1', 's2'])).toHaveLength(2);
    // Boş liste "her sunucu" anlamına GELMEZ: sorgu hiç çalıştırılmaz.
    expect(await ServerAssets.findGifsByServerIds([])).toEqual([]);

    expect(await ServerAssets.findGifByIdAndServer(one._id, 's2')).toBeNull();
    expect(await ServerAssets.findGifByIdAndServer(one._id, 's1')).not.toBeNull();
    expect(await ServerAssets.deleteGif(one._id, 's2')).toEqual({ deleted: 0 });
    expect(await ServerAssets.deleteGif(one._id, 's1')).toEqual({ deleted: 1 });

    await ServerAssets.insertGif({ serverId: 's1', url: '/g/3.gif' });
    expect(await ServerAssets.deleteGifsByServer('s1')).toEqual({ deleted: 1 });
    expect(await ServerAssets.findGifs('s2')).toHaveLength(1);
  });
});

describe('sticker pack ownership', () => {
  it('keeps packs and items resolvable only through their owning server/pack', async () => {
    await db.stickerPacks.insert({ _id: 'p1', serverId: 's1', name: 'Pack', seq: 1 });
    await db.stickerPacks.insert({ _id: 'p2', serverId: 's2', name: 'Other', seq: 2 });
    await db.stickerPackItems.insert({ _id: 'i1', packId: 'p1', name: 'one', position: 1 });
    await db.stickerPackItems.insert({ _id: 'i2', packId: 'p1', name: 'two', position: 0 });

    expect(await ServerAssets.findStickerPacksByServer('s1')).toEqual([expect.objectContaining({ _id: 'p1' })]);
    expect(await ServerAssets.findStickerPackByIdAndServer('p1', 's2')).toBeNull();
    expect(await ServerAssets.findStickerPackByIdAndServer('p1', 's1')).not.toBeNull();

    const items = await ServerAssets.findStickerItemsByPackIds(['p1']);
    expect(items.map(item => item._id)).toEqual(['i2', 'i1']); // yükleme sırası korunur
    expect(await ServerAssets.findStickerItemsByPackIds([])).toEqual([]);

    expect(await ServerAssets.findStickerItemByIdAndPack('i1', 'p2')).toBeNull();
    expect(await ServerAssets.updateStickerItem('i1', 'p2', { name: 'stolen' })).toEqual({ updated: 0 });
    expect(await ServerAssets.updateStickerItem('i1', 'p1', { name: 'ok' })).toEqual({ updated: 1 });
  });

  it('deletes a pack through one authoritative SQL statement in production', async () => {
    db._pool!.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ _id: 'p1' }] });
    expect(await asProduction(() => ServerAssets.deleteStickerPack('p1', 's1'))).toEqual({ changes: 1 });
    const [sql, params] = db._pool!.query.mock.calls.at(-1)!;
    expect(String(sql)).toContain('DELETE FROM sticker_packs');
    expect(String(sql)).toContain('"serverId" = $2');
    expect(params).toEqual(['p1', 's1']);

    db._pool!.query.mockResolvedValueOnce({ rowCount: null, rows: [] });
    expect(await asProduction(() => ServerAssets.deleteStickerPack('p1', 's1'))).toEqual({ changes: 0 });

    db._pool!.query.mockResolvedValueOnce({ rowCount: 3 });
    expect(await asProduction(() => ServerAssets.deleteStickerPacksByServer('s1'))).toEqual({ changes: 3 });
    db._pool!.query.mockResolvedValueOnce({ rowCount: undefined });
    expect(await asProduction(() => ServerAssets.deleteStickerPacksByServer('s1'))).toEqual({ changes: 0 });
  });

  it('falls back to child-then-parent removal only on the non-PostgreSQL adapter', async () => {
    await db.stickerPacks.insert({ _id: 'p1', serverId: 's1', seq: 1 });
    await db.stickerPacks.insert({ _id: 'p3', serverId: 's1', seq: 2 });
    await db.stickerPackItems.insert({ _id: 'i1', packId: 'p1' });
    await db.stickerPackItems.insert({ _id: 'i3', packId: 'p3' });
    withoutPgPool();

    expect(await ServerAssets.deleteStickerPack('p1', 's1')).toEqual({ deleted: 1 });
    expect(await db.stickerPackItems.findOne({ _id: 'i1' })).toBeNull();
    expect(await ServerAssets.deleteStickerPacksByServer('s1')).toEqual({ deleted: 1 });
    expect(await db.stickerPackItems.findOne({ _id: 'i3' })).toBeNull();
  });
});

describe('soundboard compatibility reads', () => {
  it('bounds the deprecated helpers even when the caller supplies no limit', async () => {
    for (let index = 0; index < 3; index += 1) {
      await ServerAssets.insertSound({ serverId: 's1', name: `s${index}`, url: `/u/${index}.ogg`, createdAt: index });
    }
    expect(await ServerAssets.findSounds('s1')).toHaveLength(3);
    expect(await ServerAssets.findSoundsSorted('s1')).toEqual([
      expect.objectContaining({ name: 's0' }),
      expect.objectContaining({ name: 's1' }),
      expect.objectContaining({ name: 's2' }),
    ]);
  });

  it('refuses to update or delete a sound through a foreign server id', async () => {
    const sound = await ServerAssets.insertSound({ serverId: 's1', name: 'boom', url: '/u/b.ogg' });
    expect(await ServerAssets.updateSound(sound._id, 's2', { name: 'stolen' })).toBeNull();
    expect(await ServerAssets.updateSound(sound._id, 's1', { name: 'ok' })).toEqual(
      expect.objectContaining({ name: 'ok' }),
    );
    expect(await ServerAssets.findSoundByIdAndServer(sound._id, 's2')).toBeNull();

    await db.soundboardUserStats.insert({ userId: 'u1', soundId: sound._id, playCount: 2 });
    expect(await ServerAssets.deleteSound(sound._id, 's2')).toEqual({ deleted: 0 });
    // Yabancı silme başarısız olduğu için kullanıcı istatistiği de DURMALIDIR.
    expect(await db.soundboardUserStats.findOne({ soundId: sound._id })).not.toBeNull();
    expect(await ServerAssets.deleteSound(sound._id, 's1')).toEqual({ deleted: 1 });
    expect(await db.soundboardUserStats.findOne({ soundId: sound._id })).toBeNull();
  });
});

describe('soundboard production query shape per view', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    _id: 'snd-1', name: 'Boom', emoji: '💥', url: '/uploads/soundboard/b.ogg', category: 'Server',
    scope: 'server', createdAt: 10, favorite: true, playCount: 3, favoritedAt: 500, lastPlayedAt: 400,
    scopeRank: 0, ...overrides,
  });

  it.each([
    ['favorites', 'e.favorite = TRUE', 'e."favoritedAt" DESC', [500, 0, 'snd-1']],
    ['recent', 'e."playCount" > 0', 'e."lastPlayedAt" DESC', [400, 0, 'snd-1']],
    ['frequent', 'e."playCount" > 0', 'e."playCount" DESC', [3, 400, 'snd-1']],
  ])('builds the %s view with its own filter, ordering and continuation key', async (view, filter, order, key) => {
    db._pool!.query.mockResolvedValueOnce({ rows: [row(), row({ _id: 'snd-2' })] });
    const page = await asProduction(() => ServerAssets.listSoundsPage({
      serverId: 's1', userId: 'u1', limit: 1, query: '', view: view as never, cursor: null,
    }));
    const [sql] = db._pool!.query.mock.calls.at(-1)!;
    expect(String(sql)).toContain(filter);
    expect(String(sql)).toContain(`ORDER BY ${order}`);
    expect(decodeSoundboardCursor(page.nextCursor!, view as never, '').key).toEqual(key);
  });

  it.each([
    ['favorites', '(e."favoritedAt", e._id) <'],
    ['recent', '(e."lastPlayedAt", e._id) <'],
    ['frequent', '(e."playCount", e."lastPlayedAt", e._id) <'],
    ['all', '(e."scopeRank", e."createdAt", e._id) <'],
  ])('continues the %s view with a keyset predicate rather than an offset', async (view, predicate) => {
    db._pool!.query.mockResolvedValueOnce({ rows: [] });
    await asProduction(() => ServerAssets.listSoundsPage({
      serverId: 's1', userId: 'u1', limit: 10, query: '', view: view as never,
      cursor: { view: view as never, query: '', key: [5, 6, 'anchor'] },
    }));
    const [sql, params] = db._pool!.query.mock.calls.at(-1)!;
    expect(String(sql)).toContain(predicate);
    expect(String(sql)).not.toContain('OFFSET');
    expect(params).toContain('anchor');
  });

  it('emits no WHERE clause for an unfiltered first page and stops paging when the page is not full', async () => {
    db._pool!.query.mockResolvedValueOnce({ rows: [row()] });
    const page = await asProduction(() => ServerAssets.listSoundsPage({
      serverId: 's1', userId: 'u1', limit: 10, query: '', view: 'all', cursor: null,
    }));
    const [sql] = db._pool!.query.mock.calls.at(-1)!;
    expect(String(sql)).not.toContain('WHERE e.');
    expect(page.nextCursor).toBeNull();
  });

  it('normalizes every hostile or absent column returned by the database', async () => {
    db._pool!.query.mockResolvedValueOnce({
      rows: [{ scope: 'weird', playCount: 'not-a-number', createdAt: 'x', updatedAt: '123',
        durationSeconds: null, fileSize: null, favoritedAt: null, lastPlayedAt: null }],
    });
    const page = await asProduction(() => ServerAssets.listSoundsPage({
      serverId: 's1', userId: 'u1', limit: 5, query: '', view: 'all', cursor: null,
    }));
    expect(page.items[0]).toEqual(expect.objectContaining({
      _id: '', name: '', emoji: '🔊', url: '', category: 'Server', scope: 'server',
      createdAt: 0, playCount: 0, updatedAt: 123, durationSeconds: null, fileSize: null,
      favorite: false, favoritedAt: null, lastPlayedAt: null,
    }));
  });
});

describe('soundboard per-user state upserts', () => {
  it('returns a deterministic result even when the upsert RETURNING clause yields no row', async () => {
    db._pool!.query.mockResolvedValueOnce({ rows: [] });
    expect(await asProduction(() => ServerAssets.setSoundFavorite('snd', 'u1', 's1', true)))
      .toEqual({ favorite: true, favoritedAt: expect.any(Number), playCount: 0, lastPlayedAt: null });

    db._pool!.query.mockResolvedValueOnce({ rows: [] });
    expect(await asProduction(() => ServerAssets.setSoundFavorite('snd', 'u1', null, false)))
      .toEqual({ favorite: false, favoritedAt: null, playCount: 0, lastPlayedAt: null });
    expect(db._pool!.query.mock.calls.at(-1)![1]).toEqual(['u1', 'snd', null, false, null]);

    db._pool!.query.mockResolvedValueOnce({ rows: [] });
    expect(await asProduction(() => ServerAssets.recordSoundPlay('snd', 'u1', null)))
      .toEqual({ playCount: 1, lastPlayedAt: expect.any(Number) });
  });

  it('clears favouritedAt when the favourite is removed on the compatibility adapter', async () => {
    await ServerAssets.setSoundFavorite('snd', 'u1', 's1', true);
    expect(await db.soundboardUserStats.findOne({ userId: 'u1', soundId: 'snd' })).toEqual(expect.objectContaining({ favorite: true, favoritedAt: expect.any(Number), playCount: 0 }));

    await ServerAssets.setSoundFavorite('snd', 'u1', 's1', false);
    expect(await db.soundboardUserStats.findOne({ userId: 'u1', soundId: 'snd' })).toEqual(expect.objectContaining({ favorite: false, favoritedAt: null }));
  });

  it('leaves user stats untouched when the transactional delete removes nothing', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query.mockResolvedValue({ rowCount: 0 });
    db._pool!.connect = jest.fn(async () => client) as never;

    expect(await asProduction(() => ServerAssets.deleteSound('missing', 's1'))).toEqual({ deleted: 0 });
    const statements = client.query.mock.calls.map(call => String(call[0]));
    expect(statements).toEqual([
      'BEGIN',
      expect.stringContaining('DELETE FROM soundboard'),
      'COMMIT',
    ]);
    expect(statements.some(sql => sql.includes('soundboard_user_stats'))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it('reports zero deletions when the driver omits rowCount entirely', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query.mockResolvedValue({});
    db._pool!.connect = jest.fn(async () => client) as never;
    expect(await asProduction(() => ServerAssets.deleteSound('snd', 's1'))).toEqual({ deleted: 0 });
  });
});

describe('server templates and onboarding', () => {
  it('lists every template when no filter is supplied and assigns a stable identity', async () => {
    const generated = await ServerAssets.insertTemplate({ name: 'Gaming' });
    const explicit = await ServerAssets.insertTemplate({ _id: 'fixed', name: 'Study' });
    expect(generated._id).toEqual(expect.any(String));
    expect(explicit._id).toBe('fixed');

    expect(await ServerAssets.findTemplates()).toHaveLength(2);
    expect(await ServerAssets.findTemplates({ name: 'Study' })).toHaveLength(1);
    expect(await ServerAssets.findTemplate('fixed')).toEqual(expect.objectContaining({ name: 'Study' }));
    expect(await ServerAssets.updateTemplate('fixed', { name: 'Renamed' })).toEqual({ updated: 1 });
    expect(await ServerAssets.deleteTemplate('fixed')).toEqual({ deleted: 1 });
  });

  it('coerces every onboarding field to a safe persisted shape', async () => {
    db._pool!.query.mockResolvedValueOnce({ rows: [{ _id: 'ob', enabled: true }] });
    await ServerAssets.upsertOnboarding('s1', {
      enabled: 1, rulesChannelId: 'c1', welcomeChannelId: 'c2', welcomeMessage: 'hi',
      verificationLevel: 2, defaultRoles: '["r1"]', questions: '[]', updatedAt: 42,
    });
    expect(db._pool!.query.mock.calls.at(-1)![1]!.slice(2)).toEqual([
      true, 'c1', 'c2', 'hi', 2, '["r1"]', '[]', expect.any(Number), 42,
    ]);

    // Yanlış tipler sessizce kabul edilmez; güvenli varsayılana indirgenir.
    db._pool!.query.mockResolvedValueOnce({ rows: [{ _id: 'ob' }] });
    await ServerAssets.upsertOnboarding('s1', {
      enabled: 'yes', rulesChannelId: 7, welcomeChannelId: null, welcomeMessage: { evil: true },
      verificationLevel: 1.5, defaultRoles: ['r2'], questions: [{ q: 'a' }], updatedAt: 'soon',
    });
    const params = db._pool!.query.mock.calls.at(-1)![1]!;
    expect(params.slice(2, 8)).toEqual([false, null, null, 'Sunucuya hoş geldin, {user}! 👋', 0, '["r2"]']);
    expect(params[8]).toBe('[{"q":"a"}]');
    expect(params[10]).toBe(params[9]); // geçersiz updatedAt → şimdiki zaman

    // Hiç alan verilmezse JSON sütunları boş dizi olur (null değil).
    db._pool!.query.mockResolvedValueOnce({ rows: [{ _id: 'ob' }] });
    await ServerAssets.upsertOnboarding('s1', {});
    expect(db._pool!.query.mock.calls.at(-1)![1]!.slice(7, 9)).toEqual(['[]', '[]']);
  });

  it('falls back to a change count when the onboarding upsert returns no row', async () => {
    db._pool!.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await ServerAssets.upsertOnboarding('s1', {})).toEqual({ changes: 1 });
    db._pool!.query.mockResolvedValueOnce({ rowCount: null });
    expect(await ServerAssets.upsertOnboarding('s1', {})).toEqual({ changes: 0 });
  });

  it('inserts then updates onboarding on the non-PostgreSQL adapter', async () => {
    withoutPgPool();
    await ServerAssets.upsertOnboarding('s1', { enabled: true });
    expect(await ServerAssets.findOnboarding('s1')).toEqual(expect.objectContaining({ enabled: true }));
    await ServerAssets.upsertOnboarding('s1', { enabled: false });
    expect(await ServerAssets.findOnboarding('s1')).toEqual(expect.objectContaining({ enabled: false }));
    expect(await db.serverOnboarding.count({ serverId: 's1' })).toBe(1);
  });

  it('claims an onboarding completion exactly once', async () => {
    db._pool!.query.mockResolvedValueOnce({ rowCount: 1 });
    expect(await ServerAssets.claimOnboardingCompletion({
      _id: 'c1', serverId: 's1', userId: 'u1', completedAt: 1, answers: '[]',
    })).toBe(true);
    db._pool!.query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await ServerAssets.claimOnboardingCompletion({
      _id: 'c1', serverId: 's1', userId: 'u1', completedAt: 1, answers: '[]',
    })).toBe(false);

    withoutPgPool();
    expect(await ServerAssets.claimOnboardingCompletion({
      _id: 'c2', serverId: 's1', userId: 'u2', completedAt: 1, answers: '[]',
    })).toBe(true);
    expect(await ServerAssets.claimOnboardingCompletion({
      _id: 'c2', serverId: 's1', userId: 'u2', completedAt: 1, answers: '[]',
    })).toBe(false);
  });

  it('reads completions per server and records a deterministic completion id', async () => {
    withoutPgPool();
    await ServerAssets.markOnboardingComplete('u1', 's1');
    await ServerAssets.insertOnboardingCompletion({ _id: 'u2_s2', userId: 'u2', serverId: 's2' });
    expect(await ServerAssets.findOnboardingCompletions('s1')).toEqual([
      expect.objectContaining({ _id: 'u1_s1', userId: 'u1' }),
    ]);
    expect(await ServerAssets.findOnboardingCompletion('s1', 'u1')).not.toBeNull();
    expect(await ServerAssets.findOnboardingCompletion('s2', 'u1')).toBeNull();
  });
});

describe('soundboard cursor round-trip', () => {
  it('survives encode/decode and rejects a token minted for a different view or query', () => {
    const token = encodeSoundboardCursor({ view: 'frequent', query: 'bo', key: [4, 9, 'snd-1'] });
    expect(decodeSoundboardCursor(token, 'frequent', 'bo')).toEqual({
      view: 'frequent', query: 'bo', key: [4, 9, 'snd-1'],
    });
    // Aynı jeton BAŞKA bir görünüm/arama için geçerli değildir: sayfalama
    // bağlamı değiştiğinde sıralama anahtarı da anlamını yitirir.
    expect(() => decodeSoundboardCursor(token, 'recent', 'bo')).toThrow(/Invalid soundboard cursor/);
    expect(() => decodeSoundboardCursor(token, 'frequent', 'other')).toThrow(/Invalid soundboard cursor/);
  });
});
