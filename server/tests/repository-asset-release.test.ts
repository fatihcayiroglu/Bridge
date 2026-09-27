// server/tests/repository-asset-release.test.ts
//
// Final21 Faz 19 — üyelik ve sunucu silme yollarının DOSYA BIRAKMA sözleşmesi (birim düzeyi).
// Gerçek PostgreSQL + gerçek dosya sistemi kanıtı `tests/pg-integration/member-server-asset-release.pgtest.ts`
// içindedir. Burada: havuz yokken dosyaya dokunulmadığı (fail-closed), yollar silmeden ÖNCE
// okunduğu, hata günlüğü, sunucu silmede eksik sütunların atlandığı ve dosya bırakmanın
// COMMIT SONRASI yapıldığı ölçülür.

process.env.NODE_ENV = 'test';

const releaseUnreferencedUploads = jest.fn();
const logError = jest.fn();
jest.mock('../lib/uploadRelease', () => {
  const actual = jest.requireActual('../lib/uploadRelease');
  return { ...actual, releaseUnreferencedUploads };
});
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: logError, warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import db from '../db/loader';
import MemberRepository from '../db/repositories/MemberRepository';
import ServerRepository from '../db/repositories/ServerRepository';

type Pool = { query: jest.Mock; connect: jest.Mock };
const holder = db as unknown as { _pool?: Pool; members: { insert: (d: unknown) => Promise<unknown>; find: (q: unknown) => Promise<unknown[]> } };
const originalPool = holder._pool;
const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  holder._pool = originalPool;
  process.env.NODE_ENV = originalEnv;
  jest.clearAllMocks();
});

async function seedMember(userId: string, serverId: string, serverProfile?: unknown, banned = false) {
  await holder.members.insert({ userId, serverId, banned, joinedAt: 1, ...(serverProfile === undefined ? {} : { serverProfile }) });
}

describe('MemberRepository — member-profile images follow the membership', () => {
  it('FAIL-CLOSED without PostgreSQL: the row goes, no file is released', async () => {
    holder._pool = undefined;
    await seedMember('u-np', 's-np', { avatarUrl: '/uploads/member-profiles/np.webp' });
    await MemberRepository.remove('u-np', 's-np');
    expect(await holder.members.find({ userId: 'u-np', serverId: 's-np' })).toEqual([]);
    expect(releaseUnreferencedUploads).not.toHaveBeenCalled();
  });

  it('reads the profile paths BEFORE deletion and releases them with the pool; errors are logged', async () => {
    const pool: Pool = { query: jest.fn(), connect: jest.fn() };
    holder._pool = pool;
    releaseUnreferencedUploads.mockImplementation(async (_q: unknown, _urls: string[], onError: (u: string, e: unknown) => void) => {
      onError('/uploads/member-profiles/b.webp', new Error('EACCES'));
      return { removed: 1, alreadyAbsent: 0, stillReferenced: 0, failed: 1 };
    });
    await seedMember('u-1', 's-1', { avatarUrl: '/uploads/member-profiles/a.webp', bannerUrl: '/uploads/member-profiles/b.webp' });
    await MemberRepository.remove('u-1', 's-1');
    expect(await holder.members.find({ userId: 'u-1', serverId: 's-1' })).toEqual([]);
    expect(releaseUnreferencedUploads).toHaveBeenCalledWith(pool, ['/uploads/member-profiles/a.webp', '/uploads/member-profiles/b.webp'], expect.any(Function));
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ event: 'member_profile.release_failed', url: '/uploads/member-profiles/b.webp' }), expect.any(String));
  });

  it('a membership without profile images does not call the release path at all', async () => {
    holder._pool = { query: jest.fn(), connect: jest.fn() };
    await seedMember('u-2', 's-2');
    await MemberRepository.remove('u-2', 's-2');
    expect(releaseUnreferencedUploads).not.toHaveBeenCalled();
  });

  it('unban, server-wide and account-wide removals use the same release path with the right filter', async () => {
    const pool: Pool = { query: jest.fn(), connect: jest.fn() };
    holder._pool = pool;
    releaseUnreferencedUploads.mockResolvedValue({ removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 0 });
    await seedMember('u-b', 's-b', { avatarUrl: '/uploads/member-profiles/banned.webp' }, true);
    await seedMember('u-b', 's-other', { avatarUrl: '/uploads/member-profiles/kept.webp' });
    await MemberRepository.unbanMember('s-b', 'u-b');
    expect(releaseUnreferencedUploads).toHaveBeenLastCalledWith(pool, ['/uploads/member-profiles/banned.webp'], expect.any(Function));
    expect(await holder.members.find({ userId: 'u-b', serverId: 's-other' })).toHaveLength(1);

    await seedMember('u-x', 's-all', { avatarUrl: '/uploads/member-profiles/x.webp' });
    await seedMember('u-y', 's-all', JSON.stringify({ bannerUrl: '/uploads/member-profiles/y.webp' }));
    await MemberRepository.removeAllFromServer('s-all');
    expect(releaseUnreferencedUploads).toHaveBeenLastCalledWith(pool, ['/uploads/member-profiles/x.webp', '/uploads/member-profiles/y.webp'], expect.any(Function));

    await MemberRepository.removeAllForUser('u-b');
    expect(releaseUnreferencedUploads).toHaveBeenLastCalledWith(pool, ['/uploads/member-profiles/kept.webp'], expect.any(Function));
    expect(await holder.members.find({ userId: 'u-b' })).toEqual([]);
  });
});

describe('ServerRepository.deleteGraphAtomic — server-owned files', () => {
  function client(columns: Record<string, string[]>, rows: Record<string, Array<Record<string, unknown>>>) {
    const calls: string[] = [];
    const c = {
      calls,
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (/information_schema\.tables/.test(sql)) return { rows: Object.keys(columns).map((table_name) => ({ table_name })) };
        if (/information_schema\.columns/.test(sql)) {
          return { rows: Object.entries(columns).flatMap(([table_name, names]) => names.map((column_name) => ({ table_name, column_name }))) };
        }
        if (/SELECT _id, "ownerId" FROM servers/.test(sql)) return { rows: [{ _id: 'srv', ownerId: 'own' }] };
        for (const [re, r] of Object.entries(rows)) if (new RegExp(re).test(sql)) return { rows: r };
        return { rows: [], rowCount: 0 };
      }),
    };
    return c;
  }

  it('collects icon, banner, emoji, GIF, sound, podcast and member-profile files and releases them AFTER COMMIT', async () => {
    process.env.NODE_ENV = 'production';
    const c = client({
      servers: ['_id', 'iconUrl', 'bannerUrl'], channels: ['serverId'], server_emojis: ['serverId', 'url'],
      server_gifs: ['serverId', 'url'], soundboard: ['serverId', 'url'], podcast_episodes: ['channelId', 'serverId', 'audioUrl'],
      members: ['serverId', 'serverProfile'],
    }, {
      'SELECT _id FROM channels': [{ _id: 'ch1' }],
      'SELECT "iconUrl"': [{ iconUrl: '/uploads/server-assets/icon.png' }],
      'SELECT "bannerUrl"': [{ bannerUrl: null }],
      'SELECT url FROM server_emojis': [{ url: '/uploads/emojis/e.png' }, { url: '' }, { url: 7 }],
      'SELECT url FROM server_gifs': [{ url: '/uploads/server-gifs/g.gif' }],
      'SELECT url FROM soundboard': [{ url: '/uploads/soundboard/s.ogg' }],
      '"audioUrl" FROM podcast_episodes WHERE "channelId"': [{ audioUrl: '/uploads/recordings/ep1.ogg' }],
      '"audioUrl" FROM podcast_episodes WHERE "serverId"': [{ audioUrl: '/uploads/recordings/legacy.ogg' }],
      'SELECT "serverProfile" FROM members': [{ serverProfile: { avatarUrl: '/uploads/member-profiles/m.webp' } }],
    });
    const pool: Pool = { query: jest.fn(), connect: jest.fn(async () => c) };
    holder._pool = pool;
    releaseUnreferencedUploads.mockImplementation(async (_q: unknown, _u: string[], onError: (u: string, e: unknown) => void) => {
      onError('/uploads/emojis/e.png', new Error('EBUSY'));
      return { removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 1 };
    });
    await expect(ServerRepository.deleteGraphAtomic('srv', 'own')).resolves.toBe('deleted');
    expect(releaseUnreferencedUploads).toHaveBeenCalledWith(pool, [
      '/uploads/server-assets/icon.png', '/uploads/emojis/e.png', '/uploads/server-gifs/g.gif', '/uploads/soundboard/s.ogg',
      '/uploads/recordings/ep1.ogg', '/uploads/recordings/legacy.ogg', '/uploads/member-profiles/m.webp',
    ], expect.any(Function));
    // Release happens after the transaction is durable.
    const commitAt = c.query.mock.invocationCallOrder[c.calls.indexOf('COMMIT')];
    expect(releaseUnreferencedUploads.mock.invocationCallOrder[0]).toBeGreaterThan(commitAt);
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ event: 'server_delete.asset_release_failed', serverId: 'srv' }), expect.any(String));
  });

  it('an older schema without URL/WHERE columns never queries them (the transaction must not abort) and a server with no channels skips the podcast-by-channel read', async () => {
    process.env.NODE_ENV = 'production';
    const c = client({
      servers: ['_id'], channels: ['serverId'], server_emojis: ['url'], server_gifs: ['serverId'],
      podcast_episodes: ['channelId', 'audioUrl'], members: ['serverId'],
    }, {});
    holder._pool = { query: jest.fn(), connect: jest.fn(async () => c) };
    releaseUnreferencedUploads.mockResolvedValue({ removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 0 });
    await expect(ServerRepository.deleteGraphAtomic('srv')).resolves.toBe('deleted');
    expect(c.calls.filter((s) => /^SELECT ("iconUrl"|"bannerUrl"|url|"audioUrl"|"serverProfile")/.test(s))).toEqual([]);
    expect(releaseUnreferencedUploads).toHaveBeenCalledWith(expect.anything(), [], expect.any(Function));
  });

  it('a failing transaction releases nothing', async () => {
    process.env.NODE_ENV = 'production';
    const c = client({ servers: ['_id', 'iconUrl'], messages: ['serverId'] }, { 'SELECT "iconUrl"': [{ iconUrl: '/uploads/server-assets/i.png' }] });
    const base = c.query.getMockImplementation()!;
    c.query.mockImplementation(async (sql: string) => {
      if (/DELETE FROM "messages"/.test(sql)) throw new Error('lock timeout');
      return base(sql);
    });
    holder._pool = { query: jest.fn(), connect: jest.fn(async () => c) };
    await expect(ServerRepository.deleteGraphAtomic('srv')).rejects.toThrow('lock timeout');
    expect(c.calls).toContain('ROLLBACK');
    expect(releaseUnreferencedUploads).not.toHaveBeenCalled();
  });
});
