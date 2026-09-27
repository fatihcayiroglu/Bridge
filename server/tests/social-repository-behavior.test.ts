process.env.NODE_ENV = 'test';

const mockDb: any = {
  friendships: {},
  blocks: {},
  userConnections: {},
};

jest.mock('../db/loader', () => mockDb);

import Social from '../db/repositories/SocialRepository';

function collection() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  };
}

function resetCollections() {
  mockDb.friendships = collection();
  mockDb.blocks = collection();
  mockDb.userConnections = collection();
  delete mockDb._pool;
}

function poolClient(handler: (sql: string, params?: unknown[]) => any) {
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
    release: jest.fn(),
  };
  mockDb._pool = { connect: jest.fn(async () => client) };
  return client;
}

describe('SocialRepository concurrency and authority contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCollections();
  });

  it('queries friendships in both orientations and preserves canonical mutation ids', async () => {
    mockDb.friendships.findOne.mockResolvedValue({ _id: 'f1' });
    await expect(Social.findFriendship('u1', 'u2')).resolves.toEqual({ _id: 'f1' });
    expect(mockDb.friendships.findOne).toHaveBeenCalledWith({ $or: [
      { userId: 'u1', friendId: 'u2' }, { userId: 'u2', friendId: 'u1' },
    ] });

    mockDb.friendships.find.mockResolvedValue([{ _id: 'f1' }]);
    await expect(Social.findFriendships('u1')).resolves.toEqual([{ _id: 'f1' }]);
    expect(mockDb.friendships.find).toHaveBeenCalledWith({ $or: [{ userId: 'u1' }, { friendId: 'u1' }] });

    mockDb.friendships.update.mockResolvedValue(undefined);
    await Social.acceptFriendship('f1');
    expect(mockDb.friendships.update).toHaveBeenCalledWith({ _id: 'f1' }, { $set: { status: 'accepted' } });
    await Social.declineFriendship('f1');
    expect(mockDb.friendships.update).toHaveBeenLastCalledWith({ _id: 'f1' }, { $set: { status: 'declined' } });
    await Social.removeFriendship('f1');
    expect(mockDb.friendships.remove).toHaveBeenCalledWith({ _id: 'f1' });
  });

  it('serializes fallback friendship creation and does not create reverse-direction duplicates', async () => {
    const rows: any[] = [];
    mockDb.friendships.findOne.mockImplementation(async (query: any) => rows.find((r) =>
      query.$or.some((q: any) => r.userId === q.userId && r.friendId === q.friendId),
    ) ?? null);
    mockDb.friendships.insert.mockImplementation(async (row: any) => { rows.push(row); return row; });

    const [a, b] = await Promise.all([
      Social.createFriendship('u1', 'u2'),
      Social.createFriendship('u2', 'u1'),
    ]);
    expect(rows).toHaveLength(1);
    expect(a._id).toBe(b._id);
    expect(rows[0]).toMatchObject({ status: 'pending' });
    await expect(Social.createFriendship('u1', 'u1')).rejects.toThrow(/invalid friendship pair/);
  });

  it('uses a cross-node advisory lock for an unordered friendship pair and returns existing rows', async () => {
    const existing = { _id: 'f-existing', userId: 'u2', friendId: 'u1', status: 'pending' };
    const client = poolClient((sql) => {
      if (sql.includes('SELECT * FROM friendships')) return { rows: [existing] };
      return { rows: [] };
    });
    await expect(Social.createFriendship('u2', 'u1')).resolves.toEqual(existing);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual([
      'BEGIN', expect.stringContaining('pg_advisory_xact_lock'), expect.stringContaining('SELECT * FROM friendships'), 'COMMIT',
    ]);
    expect(client.query.mock.calls[1][1]).toEqual([JSON.stringify(['u1', 'u2'])]);
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO friendships'))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('creates a friendship inside the same transaction and rolls back preserving database errors', async () => {
    let insertedParams: unknown[] | undefined;
    const client = poolClient((sql, params) => {
      if (sql.includes('SELECT * FROM friendships')) return { rows: [] };
      if (sql.includes('INSERT INTO friendships')) { insertedParams = params; return { rows: [{ _id: 'f-new' }] }; }
      return { rows: [] };
    });
    await expect(Social.createFriendship('u1', 'u2')).resolves.toEqual({ _id: 'f-new' });
    expect(insertedParams?.slice(1, 3)).toEqual(['u1', 'u2']);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);

    const original = new Error('friendship query failed');
    const failing = poolClient((sql) => {
      if (sql.includes('SELECT * FROM friendships')) throw original;
      if (sql === 'ROLLBACK') throw new Error('rollback also failed');
      return { rows: [] };
    });
    await expect(Social.createFriendship('u1', 'u3')).rejects.toBe(original);
    expect(failing.query).toHaveBeenCalledWith('ROLLBACK');
    expect(failing.query).not.toHaveBeenCalledWith('COMMIT');
    expect(failing.release).toHaveBeenCalledTimes(1);
  });

  it('keeps block and connection stores required and propagates their failures', async () => {
    mockDb.blocks = undefined;
    await expect(Social.findBlock('u1', 'u2')).rejects.toThrow(/blocks store unavailable/);
    mockDb.blocks = collection();
    mockDb.blocks.find.mockRejectedValue(new Error('block db down'));
    await expect(Social.findBlocksByUser('u1')).rejects.toThrow('block db down');

    mockDb.userConnections = undefined;
    await expect(Social.findConnection('u1', 'github')).rejects.toThrow(/userConnections store unavailable/);
  });

  it('connection insert owns identity fields even when callers try to overwrite them', async () => {
    mockDb.userConnections.insert.mockImplementation(async (row: any) => row);
    const created: any = await Social.insertConnection({
      _id: 'attacker-id', createdAt: 1, userId: 'u1', platform: 'github', username: 'alice', url: 'https://x',
    });
    expect(created.userId).toBe('u1');
    expect(created.platform).toBe('github');
    expect(created._id).not.toBe('attacker-id');
    expect(created.createdAt).not.toBe(1);
    await expect(Social.insertConnection({ userId: '', platform: 'github' })).rejects.toThrow(/required/);
  });

  it('fallback connection upsert updates existing rows without consuming capacity', async () => {
    const existing = { _id: 'c1', userId: 'u1', platform: 'github', username: 'old', url: 'old' };
    mockDb.userConnections.findOne
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({ ...existing, username: 'new', url: 'new-url' });
    mockDb.userConnections.update.mockResolvedValue(undefined);

    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'new', url: 'new-url' })).resolves.toEqual({
      status: 'ok', connection: { ...existing, username: 'new', url: 'new-url' },
    });
    expect(mockDb.userConnections.count).not.toHaveBeenCalled();
    expect(mockDb.userConnections.insert).not.toHaveBeenCalled();
  });

  it('fallback connection upsert enforces capacity atomically and inserts below the cap', async () => {
    mockDb.userConnections.findOne.mockResolvedValue(null);
    mockDb.userConnections.count.mockResolvedValueOnce(10);
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u' })).resolves.toEqual({ status: 'limit' });
    expect(mockDb.userConnections.insert).not.toHaveBeenCalled();

    mockDb.userConnections.count.mockResolvedValueOnce(9);
    mockDb.userConnections.insert.mockImplementation(async (row: any) => row);
    const out = await Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u', verified: true });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.connection).toMatchObject({ userId: 'u1', platform: 'github', verified: true });
  });

  it('production connection upsert locks the owner row and updates an existing platform atomically', async () => {
    const client = poolClient((sql) => {
      if (sql.includes('SELECT _id FROM users')) return { rows: [{ _id: 'u1' }] };
      if (sql.includes('SELECT * FROM user_connections')) return { rows: [{ _id: 'c1' }] };
      if (sql.includes('UPDATE user_connections')) return { rows: [{ _id: 'c1', username: 'new' }] };
      return { rows: [] };
    });
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'new', url: 'url' })).resolves.toEqual({
      status: 'ok', connection: { _id: 'c1', username: 'new' },
    });
    expect(client.query.mock.calls.map((c) => c[0])).toEqual([
      'BEGIN', expect.stringContaining('FROM users'), expect.stringContaining('FROM user_connections'), expect.stringContaining('UPDATE user_connections'), 'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('production connection upsert rolls back at the cap and inserts below it', async () => {
    const capped = poolClient((sql) => {
      if (sql.includes('SELECT _id FROM users')) return { rows: [{ _id: 'u1' }] };
      if (sql.includes('SELECT * FROM user_connections')) return { rows: [] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '10' }] };
      return { rows: [] };
    });
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u' })).resolves.toEqual({ status: 'limit' });
    expect(capped.query).toHaveBeenCalledWith('ROLLBACK');
    expect(capped.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO user_connections'))).toBe(false);

    let insertParams: unknown[] | undefined;
    const inserting = poolClient((sql, params) => {
      if (sql.includes('SELECT _id FROM users')) return { rows: [{ _id: 'u1' }] };
      if (sql.includes('SELECT * FROM user_connections')) return { rows: [] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '9' }] };
      if (sql.includes('INSERT INTO user_connections')) { insertParams = params; return { rows: [{ _id: 'c-new' }] }; }
      return { rows: [] };
    });
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u', verified: 1 })).resolves.toEqual({
      status: 'ok', connection: { _id: 'c-new' },
    });
    expect(insertParams?.slice(1, 5)).toEqual(['u1', 'github', 'a', 'u']);
    expect(inserting.query).toHaveBeenCalledWith('COMMIT');
  });

  it('production connection upsert rejects invalid limits and rolls back owner/database failures', async () => {
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u' }, 0)).rejects.toThrow(/maxConnections/);
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u' }, 1.5)).rejects.toThrow(/maxConnections/);

    const missingOwner = poolClient((sql) => sql.includes('SELECT _id FROM users') ? { rows: [] } : { rows: [] });
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u' })).rejects.toThrow(/owner not found/);
    expect(missingOwner.query).toHaveBeenCalledWith('ROLLBACK');
    expect(missingOwner.release).toHaveBeenCalledTimes(1);

    const original = new Error('count failed');
    const failing = poolClient((sql) => {
      if (sql.includes('SELECT _id FROM users')) return { rows: [{ _id: 'u1' }] };
      if (sql.includes('SELECT * FROM user_connections')) return { rows: [] };
      if (sql.includes('COUNT(*)')) throw original;
      return { rows: [] };
    });
    await expect(Social.upsertConnectionWithinLimit('u1', 'github', { username: 'a', url: 'u' })).rejects.toBe(original);
    expect(failing.query).toHaveBeenCalledWith('ROLLBACK');
    expect(failing.query).not.toHaveBeenCalledWith('COMMIT');
    expect(failing.release).toHaveBeenCalledTimes(1);
  });
});
