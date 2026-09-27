process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

import Members from '../db/repositories/MemberRepository';

describe('MemberRepository active-member queries', () => {
  beforeEach(() => {
    mockDb._reset?.();
    delete (mockDb as unknown as { _pool?: unknown })._pool;
  });

  it('findByServer/findByServerIds exclude banned rows while getBans keeps them visible', async () => {
    await mockDb.members.insert({ userId: 'active', serverId: 's1', joinedAt: 1, banned: false });
    await mockDb.members.insert({ userId: 'banned', serverId: 's1', joinedAt: 1, banned: true });

    await expect(Members.findByServer('s1')).resolves.toEqual([
      expect.objectContaining({ userId: 'active' }),
    ]);
    await expect(Members.findByServerIds(['s1'])).resolves.toEqual([
      expect.objectContaining({ userId: 'active' }),
    ]);
    await expect(Members.getBans('s1')).resolves.toEqual([
      expect.objectContaining({ userId: 'banned', banned: true }),
    ]);
  });

  it('pages active members deterministically across tied join timestamps', async () => {
    await mockDb.members.insert({ userId: 'member-b', serverId: 's1', joinedAt: 10, banned: false });
    await mockDb.members.insert({ userId: 'member-a', serverId: 's1', joinedAt: 10, banned: false });
    await mockDb.members.insert({ userId: 'member-z', serverId: 's1', joinedAt: 5, banned: false });
    await mockDb.members.insert({ userId: 'member-banned', serverId: 's1', joinedAt: 1, banned: true });
    await mockDb.members.insert({ userId: 'other-server', serverId: 's2', joinedAt: 1, banned: false });

    const first = await Members.findPageByServer('s1', { limit: 2 });
    expect(first.map(row => row.userId)).toEqual(['member-z', 'member-a']);

    const second = await Members.findPageByServer('s1', {
      limit: 2,
      cursor: { joinedAt: 10, userId: 'member-a' },
    });
    expect(second.map(row => row.userId)).toEqual(['member-b']);
  });

  it('uses the indexed PostgreSQL tuple predicate and normalizes BIGINT timestamps', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ userId: 'member-b', serverId: 's1', joinedAt: '10', banned: false }],
    });
    (mockDb as unknown as { _pool: { query: typeof query } })._pool = { query };

    await expect(Members.findPageByServer('s1', {
      limit: 11,
      cursor: { joinedAt: 10, userId: 'member-a' },
    })).resolves.toEqual([
      expect.objectContaining({ userId: 'member-b', joinedAt: 10 }),
    ]);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('("joinedAt", "userId") > ($2::bigint, $3::text)');
    expect(sql).toContain('ORDER BY "joinedAt" ASC, "userId" ASC');
    expect(sql).toContain('banned = FALSE');
    expect(params).toEqual(['s1', 10, 'member-a', 11]);
  });

  it.each([0, 102, 1.5])('rejects an unsafe internal page limit %s', async (limit) => {
    await expect(Members.findPageByServer('s1', { limit })).rejects.toThrow(/limit/i);
  });
});
